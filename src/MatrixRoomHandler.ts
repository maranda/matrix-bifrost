import { Bridge, MatrixUser, Intent, Logging, WeakEvent, RoomBridgeStoreEntry } from "matrix-appservice-bridge";
import { IBifrostInstance } from "./bifrost/Instance";
import { MROOM_TYPE_GROUP, MROOM_TYPE_IM, IRemoteGroupData } from "./store/Types";
import {
    IReceivedImMsg,
    IChatInvite,
    IChatJoined,
    IConversationEvent,
    IUserStateChanged,
    IChatTopicState,
    IChatAvatarState,
    IChatTyping,
    IStoreRemoteUser,
    IChatReadReceipt,
    IFetchReceivedGroupMsg,
} from "./bifrost/Events";
import { ProfileSync } from "./ProfileSync";
import { Util } from "./Util";
import { ProtoHacks } from "./ProtoHacks";
import { IStore } from "./store/Store";
import { Deduplicator } from "./Deduplicator";
import { Config } from "./Config";
import { decode as entityDecode } from "html-entities";
import { MessageFormatter } from "./MessageFormatter";
import request from "axios";
const log = Logging.get("MatrixRoomHandler");

const ACCOUNT_LOCK_MS = 1000;
const EVENT_MAPPING_SIZE = 16384;

/**
 * Handles creation and handling of rooms.
 */
export class MatrixRoomHandler {
    private bridge?: Bridge;
    private accountRoomLock: Set<string>;
    private alreadyKnownSenders: Set<string>;
    private remoteEventIdMapping: Map<string, string>; // remote_id -> event_id
    private roomCreationLock: Map<string, Promise<RoomBridgeStoreEntry>>;
    private remoteEntriesCache: Map<IRemoteGroupData, any>;
    constructor(
        private purple: IBifrostInstance,
        private profileSync: ProfileSync,
        private store: IStore,
        private config: Config,
        private deduplicator: Deduplicator,
    ) {
        this.accountRoomLock = new Set();
        this.alreadyKnownSenders = new Set();
        this.roomCreationLock = new Map();
        this.remoteEntriesCache = new Map();
        if (this.purple.needsDedupe() || this.purple.needsAccountLock()) {
            purple.on("chat-joined", this.onChatJoined.bind(this));
        }
        purple.on("chat-joined-new", async (ev: IChatJoined) => {
            try {
                log.info("Handling joining of new chat", ev.account.username, ev.conv, ev.join_properties);
                const matrixUser = await this.store.getMatrixUserForAccount(ev.account);
                if (!matrixUser) {
                    log.warn("Got a joined chat for an account not tied to a matrix user. WTF?");
                    return;
                }
                if (!this.bridge) {
                    log.warn("Got chat-joined-new but bridge was not defined yet");
                    return;
                }
                const intent = this.bridge.getIntent();
                const roomId = await this.createOrGetGroupChatRoom(ev, intent);
                if (!ev.should_invite) {
                    // Not all backends need to invite users to their rooms.
                    return false;
                }
                const memberlist = Object.keys((await this.bridge.getBot().getJoinedMembers(roomId)));
                if (!memberlist.includes(matrixUser.getId())) {
                    log.debug(`Invited ${matrixUser.getId()} to a chat they tried to join`);
                    await intent.invite(roomId, matrixUser.getId()).catch((err) => {
                        log.error(`Failed to invite user ${matrixUser.getId()} into ${roomId}`);
                    });
                }
            } catch (ex) {
                log.error("Exception while handling chat-joined-new event:", ex);
            }
        });
        purple.on("received-im-msg", this.handleIncomingIM.bind(this));
        purple.on("received-chat-msg", this.handleIncomingChatMsg.bind(this));
        purple.on("chat-invite", this.handleChatInvite.bind(this));
        purple.on("chat-user-joined", this.handleRemoteUserState.bind(this));
        purple.on("chat-user-left", this.handleRemoteUserState.bind(this));
        purple.on("chat-user-kick", this.handleRemoteUserState.bind(this));
        /* This also handles chat names, which are just set as the conv.name */
        purple.on("chat-topic", this.handleTopic.bind(this));
        purple.on("chat-avatar", this.handleRoomAvatar.bind(this));
        purple.on("im-typing", this.handleIMTyping.bind(this));
        purple.on("chat-typing", this.handleChatTyping.bind(this));
        purple.on("store-remote-user", (storeUser: IStoreRemoteUser) => {
            try {
                log.info(`Storing remote ghost for ${storeUser.mxId} -> ${storeUser.remoteId}`);
                this.store.storeGhost(
                    storeUser.mxId,
                    this.purple.getProtocol(storeUser.protocol_id)!,
                    storeUser.remoteId,
                    storeUser.data,
                );
                if (!this.alreadyKnownSenders.has(storeUser.remoteId)) {
                    this.alreadyKnownSenders.add(storeUser.remoteId);
                }
            } catch (ex) {
                log.error("Exception while handling store-remote-user event:", ex);
            }
        });
        this.remoteEventIdMapping = new Map();
        purple.on("read-receipt", this.handleReadReceipt.bind(this));
        purple.on("remove-room-lock", (data: { roomId: string }) => {
            log.info(`Called for creation lock deletion on ${data.roomId}, probably room was plumbed...`);
            this.roomCreationLock.delete(data.roomId);
        });
        purple.on("initialize-instance", this.handleStartup.bind(this));
    }

    /**
     * Set the bridge for us to use. This must be called after MatrixEventHandler
     * has been created.
     *
     * @return [description]
     */
    public setBridge(bridge: Bridge) {
        this.bridge = bridge;
    }

    public async onChatJoined(ev: IConversationEvent) {
        try {
            if (this.purple.needsDedupe()) {
                this.deduplicator.incrementRoomUsers(ev.conv.name);
            }

            if (this.purple.needsAccountLock()) {
                let id = Util.createRemoteId(ev.account.protocol_id, ev.account.username);
                id = `${id}/${ev.conv.name}`;
                this.accountRoomLock.add(id);
                setTimeout(() => {
                    log.debug(`AccountLock unlocking ${id}`);
                    this.accountRoomLock.delete(id);
                }, ACCOUNT_LOCK_MS);
            }
        } catch (ex) {
            log.error("onChatJoined() exception:", ex);
        }
    }

    private async getIMRoomId(data: { account: { protocol_id: string }, sender: string }, matrixUser: MatrixUser): Promise<string | null> {
        try {
            // Check to see if we have a room for this IM.
            const remoteId = Buffer.from(
                `${matrixUser.getId()}:${data.account.protocol_id}:${data.sender}`,
            ).toString("base64");
            if (this.roomCreationLock.has(remoteId)) {
                log.info(remoteId, "is already being created, waiting...");
                await (this.roomCreationLock.get(remoteId) || Promise.resolve());
                log.info("room was created, no longer waiting");
            }
            const remoteEntries = await this.store.getIMRoom(matrixUser.getId(), data.account.protocol_id, data.sender);
            if (remoteEntries != null && remoteEntries.matrix) {
                return remoteEntries.matrix.getId();
            }
            return null;
        } catch (ex) {
            log.error("getIMRoomId() exception:", ex);
        }
    }

    private async createOrGetIMRoom(data: IReceivedImMsg, matrixUser: MatrixUser, intent: Intent): Promise<string> {
        try {
            const existingRoomId = await this.getIMRoomId(data, matrixUser);
            if (existingRoomId) {
                return existingRoomId;
            }
            const remoteId = Buffer.from(
                `${matrixUser.getId()}:${data.account.protocol_id}:${data.sender}`,
            ).toString("base64");

            // Room doesn't exist yet, create it.
            log.info(`Couldn't find room for IM ${matrixUser.getId()} <-> ${data.sender}. Creating a new one`);
            const remoteData = {
                matrixUser: matrixUser.getId(),
                protocol_id: data.account.protocol_id,
                recipient: data.sender,
            };
            let roomId: string;
            const createPromise = intent.createRoom({
                createAsClient: true,
                options: {
                    is_direct: true,
                    visibility: "private",
                    invite: [matrixUser.getId()],
                },
            }).then(({ room_id }) => {
                roomId = room_id;
                log.debug("Created room with id ", room_id);
                return this.store.storeRoom(roomId, MROOM_TYPE_IM, remoteId, remoteData);
            });

            try {
                this.roomCreationLock.set(remoteId, createPromise);
                const result = await createPromise;
                if (this.config.tuning.waitOnJoinBeforePM.find((prefix) => matrixUser.localpart.startsWith(prefix))) {
                    log.info(
                        "Recipient matches waitOnJoinBeforePM, holding back sending messages until the user has joined",
                    );
                    await this.deduplicator.waitForJoin(result.matrix.getId(), matrixUser.getId());
                    log.info("User joined, can now send messages");
                }
                this.roomCreationLock.delete(remoteId);
                return result.matrix.getId();
            } catch (ex) {
                log.error("Failed to create room", ex);
                this.roomCreationLock.delete(remoteId);
                throw ex;
            }
        } catch (ex) {
            log.error("createOrGetIMRoom() exception:", ex);
        }
    }

    private async createOrGetGroupChatRoom(
        data: IConversationEvent|IChatInvite|IChatJoined|IUserStateChanged,
        intent: Intent,
        getOnly: boolean = false,
        failIfPlumbed: boolean = false,
    ) {
        try {
            let roomName;
            let props;
            if ("join_properties" in data) {
                roomName = ProtoHacks.getRoomNameForInvite(data);
                props = Object.assign({}, data.join_properties);
            } else {
                roomName = data.conv.name;
            }
            const remoteId = Buffer.from(
                `${data.account.protocol_id}:${roomName}`,
            ).toString("base64");
            if (this.roomCreationLock.has(remoteId)) {
                log.info(remoteId, "is already being created, waiting...");
                await (this.roomCreationLock.get(remoteId) || Promise.resolve());
                log.info("room was created, no longer waiting");
            }

            // XXX: This is potentially fragile as we are basically doing a lookup via
            // a set of properties we hope will be unique.
            if (props) {
                ProtoHacks.removeSensitiveJoinProps(data.account.protocol_id, props);
            }
            let remoteData: IRemoteGroupData = {
                protocol_id: data.account.protocol_id,
                room_name: roomName,
            };
            log.debug("Searching for existing remote room:", remoteData);
            // For some reason the following function wites to remoteData, so recreate it later
            const remoteEntry = await this.store.getGroupRoomByRemoteData(remoteData);
            if (remoteEntry) {
                if (remoteEntry.remote?.get("plumbed") && failIfPlumbed) {
                    return false;
                }
                return remoteEntry.matrix?.getId();
            }

            // This could be that this is the first user to join a gateway room
            // so we should try to create an entry for it ahead of time.
            if ((data as any).gatewayAlias) {
                const alias = ((data as any).gatewayAlias);

                if (!this.bridge) {
                    log.error("Got gateway join request, but bridge was not defined");
                    return;
                }

                log.info("Request was a gateway request, so attempting to find room and create an entry");
                try {
                    const roomId = (await this.bridge.getIntent().getClient().getRoomIdForAlias(alias)).room_id;
                    remoteData.gateway = true;
                    log.info(`Found ${roomId} for ${alias}`);
                    await this.store.storeRoom(roomId, MROOM_TYPE_GROUP, remoteId, remoteData);
                    return roomId;
                } catch (ex) {
                    log.warn("Room was not found", ex);
                    throw Error("Room doesn't exist, refusing to make room");
                }
            }

            if (getOnly) {
                throw new Error("Room doesn't exist, refusing to make room");
            }

            const createPromise = new Promise(() => {
                // Room doesn't exist yet, create it.
                remoteData = {
                    protocol_id: data.account.protocol_id,
                    room_name: roomName,
                    properties: props ? Util.sanitizeProperties(props) : {}, // for joining
                } as any;
                log.info(`Couldn't find room for ${roomName}. Creating a new one`);
                return intent.createRoom({
                    createAsClient: false,
                    options: {
                        name: roomName,
                        visibility: "private",
                    },
                });
            }).then((res: any) => {
                log.debug("Created room with id ", res.room_id);
                return this.store.storeRoom(res.room_id, MROOM_TYPE_GROUP, remoteId, remoteData);
            });
            try {
                this.roomCreationLock.set(remoteId, createPromise);
                const result = await createPromise;
                this.roomCreationLock.delete(remoteId);
                return result.matrix.getId();
            } catch (ex) {
                log.error("Failed to create room", ex);
                this.roomCreationLock.delete(remoteId);
                throw ex;
            }
        } catch (ex) {
            log.error("createOrGetGroupChatRoom() exception:", ex);
        }
    }

    private async handleIncomingIM(data: IReceivedImMsg) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleIncomingIM, bridge was not defined");
            }
            log.debug(`Handling incoming IM from ${data.sender}`);
            data.message.body = entityDecode(data.message.body);
            // First, find out who the message was intended for.
            const matrixUser = await this.store.getMatrixUserForAccount(data.account);
            if (matrixUser === null) {
                return;
            }
            const protocol = this.purple.getProtocol(data.account.protocol_id);
            if (!protocol) {
                log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
                return;
            }
            log.debug(`Message intended for ${matrixUser.getId()}`);
            const senderMatrixUser = protocol.getMxIdForProtocol(
                data.sender,
                this.config.bridge.domain,
                this.config.bridge.userPrefix,
            );

            // Update the user if needed.
            const account = this.purple.getAccount(data.account.username, data.account.protocol_id, matrixUser.getId());
            if (account) {
                await this.profileSync.updateProfile(protocol, data.sender, account);
            }

            const intent = this.bridge.getIntent(senderMatrixUser.getId());
            log.debug("Identified ghost user as", senderMatrixUser.getId());
            let roomId: string;
            try {
                roomId = await this.createOrGetIMRoom(data, matrixUser, intent);
            } catch (e) {
                log.error(`Failed to get/create room for this IM: ${e}`);
                return;
            }

            try {
                await intent.join(roomId);
            } catch (ex) {
                log.warn("Not joined to room, discarding " + roomId);
                await this.store.removeRoomByRoomId(roomId);
                roomId = await this.createOrGetIMRoom(data, matrixUser, intent);
            }

            if (data.message.redacted) {
                // do nothing
                log.info(`Received retraction by ${data.sender} for ${data.message.redacted.redact_id}`);
                try {
                    const isKnown = await intent.getEvent(roomId, data.message.redacted.redact_id, true).catch((ex) => {
                        log.error("Failed to fetch original message for redaction:", ex);
                    }) as WeakEvent;
                    if (isKnown) {
                        await intent.getClient().redactEvent(roomId, data.message.redacted.redact_id);
                    } else {
                        throw Error(`Failed to redact, we don't know about ${data.message.redacted.redact_id}`);
                    }
                } catch (e) {
                    log.error(`Failed to redact message for this IM: ${e}`);
                }
                return;
            }

            log.info(`Sending IM to ${roomId} as ${senderMatrixUser.getId()}`);
            if (data.message.original_message) {
                data.message.original_message = (
                    await this.store.getMatrixEventId(roomId, data.message.original_message)
                ) || undefined;
            }
            const content = await MessageFormatter.messageToMatrixEvent(data.message, protocol, intent);
            const { event_id } = await intent.sendMessage(roomId, content) as { event_id: string };
            if (data.message.id) {
                this.remoteEventIdMapping.set(data.message.id, event_id);
                // Remove old entires.
                if (this.remoteEventIdMapping.size >= EVENT_MAPPING_SIZE) {
                    const keyArr = [...this.remoteEventIdMapping.keys()].slice(0, 50);
                    keyArr.forEach(this.remoteEventIdMapping.delete.bind(this.remoteEventIdMapping));
                }
                await this.store.storeRoomEvent(
                    roomId, event_id, data.message.id, data.message.origin_id, data.message.stanza_id
                ).catch((ev) => {
                    log.warn("Failed to store event mapping:", ev);
                });
            }
        } catch (ex) {
            log.error("handleIncomingIM() exception:", ex);
        }
    }

    private async handleIncomingChatMsg(data: IReceivedImMsg) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleIncomingChatMsg, bridge was not defined");
            }
            log.debug(`Handling incoming chat from ${data.sender} (${data.conv.name})`);
            data.message.body = entityDecode(data.message.body);
            const acctId = Util.createRemoteId(data.account.protocol_id, data.account.username);
            if (this.accountRoomLock.has(
                acctId + "/" + data.conv.name)
            ) {
                // This account has recently connected and about to flood the room with
                // messages. We're going to ignore them.
                return;
            }
            const remoteId = Util.createRemoteId(data.account.protocol_id, data.sender);
            if (this.purple.needsDedupe() && this.deduplicator.checkAndRemove(
                data.conv.name,
                remoteId,
                data.message.body,
            )) {
                return;
            }

            if (this.purple.needsDedupe() && !this.deduplicator.isTheChosenOneForRoom(data.conv.name, acctId)) {
                return;
            }
            // this.purple.getBuddyFromChat(data.conv, data.sender);
            // If multiple of our users are in this room, it may dupe up here.
            const protocol = this.purple.getProtocol(data.account.protocol_id);
            if (!protocol) {
                log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
                return;
            }
            const senderMatrixUser = protocol.getMxIdForProtocol(
                data.sender,
                this.config.bridge.domain,
                this.config.bridge.userPrefix,
            );
            const account = this.purple.getAccount(data.account.username, data.account.protocol_id);
            if (account) {
                await this.profileSync.updateProfile(
                    protocol,
                    data.sender,
                    account,
                    false,
                    ProtoHacks.getSenderIdToLookup(protocol, data.sender, data.conv.name),
                );
            }

            const intent = this.bridge.getIntent(senderMatrixUser.getId());
            let roomId;
            try {
                // Note that this will not invite anyone.
                roomId = await this.createOrGetGroupChatRoom(data, intent);
            } catch (e) {
                log.error(`Failed to get/create room for this chat:`, e);
                return;
            }
            if (data.message.redacted) {
                // do nothing
                log.info(`Received retraction by ${data.sender}, handling for ${data.message.redacted.redact_id} -> ${data.conv.name}`);
                try {
                    const isKnown = await intent.getEvent(roomId, data.message.redacted.redact_id, true).catch((ex) => {
                        log.error("Failed to fetch original message for redaction:", ex);
                    }) as WeakEvent;
                    if (isKnown?.sender === senderMatrixUser.userId) {
                        await intent.getClient().redactEvent(roomId, data.message.redacted.redact_id);
                    } else {
                        throw Error(`Failed to redact ${data.message.redacted.redact_id} -> ds:${senderMatrixUser.userId} ks:${isKnown?.sender}`);
                    }
                } catch (e) {
                    log.error(`Failed to redact message for this Group: ${e}`);
                }
                return;
            }
            if (data.message.original_message) {
                data.message.original_message = (
                    await this.store.getMatrixEventId(roomId, data.message.original_message)
                ) || undefined;
            }
            const content = await MessageFormatter.messageToMatrixEvent(data.message, protocol, intent);
            const { event_id } = await intent.sendMessage(roomId, content).catch((ex) => {
                log.error("Failed to send message:", ex);
            }) as { event_id: string };
            this.purple.emit("mam-add-entry", {
                room_id: roomId,
                event: await intent.getEvent(roomId, event_id, true).catch((ex) => {
                    log.error("Failed to fetch event to store into MAM:", ex);
                }),
            } as IFetchReceivedGroupMsg);
            if (data.message.id) {
                await this.store.storeRoomEvent(
                    roomId, event_id, data.message.id, data.message.origin_id, data.message.stanza_id
                ).catch((ex) => {
                    log.warn("Failed to store event mapping:", ex);
                });
            }
        } catch (ex) {
            log.error("handleIncomingChatMsg() exception:", ex);
        }
    }

    private async handleChatInvite(data: IChatInvite) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleChatInvite, bridge was not defined");
            }
            log.debug(`Handling invite to chat from ${data.sender} -> ${data.room_name}`);
            // First, find out who the message was intended for.
            const matrixUser = await this.store.getMatrixUserForAccount(data.account);
            if (matrixUser === null) {
                return;
            }
            const protocol = this.purple.getProtocol(data.account.protocol_id);
            if (!protocol) {
                log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
                return;
            }
            const senderMatrixUser = protocol.getMxIdForProtocol(
                data.sender,
                this.config.bridge.domain,
                this.config.bridge.userPrefix,
            );
            const intent = this.bridge.getIntent(senderMatrixUser.getId());
            let roomId;
            // XXX: These chats are shared across multiple matrix users potentially,
            // so remember to invite newbloods.
            try {
                // This will create the room and invite the user.
                roomId = await this.createOrGetGroupChatRoom(data, intent);
                log.debug(`Found room ${roomId} for ${data.room_name}`);
                intent.invite(roomId, matrixUser.getId());
            } catch (e) {
                log.error(`Failed to handle invite: ${e}`);
                return;
            }
            // XXX: Matrix doesn't support invite messages
        } catch (ex) {
            log.error("handleChatInvite() exception:", ex);
        }
    }

    private async handleRemoteUserState(data: IUserStateChanged) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleRemoteUserState, bridge was not defined");
            }
            const protocol = this.purple.getProtocol(data.account.protocol_id)!;
            const remoteUser = await this.store.getRemoteUserBySender(data.sender, protocol);
            if (remoteUser && !remoteUser.isRemote) {
                log.info(`Didn't handle join/leave/kick for ${data.sender}, isn't remote: ${remoteUser.id} -> ${remoteUser.isRemote}`);
                return; // Do NOT handle state changes from our own users.
            }
            let verb;
            if (data.state === "joined") {
                verb = "Joining";
            } else if (data.state === "left") {
                verb = "Leaving";
            } else if (data.state === "kick") {
                verb = "Kicking";
            }
            log.info(verb, data.sender, "from", data.conv.name);
            const senderMatrixUser = protocol.getMxIdForProtocol(
                data.sender,
                this.config.bridge.domain,
                this.config.bridge.userPrefix,
            );
            if (senderMatrixUser.getId().match(/.*=fffd.*/) && data.state === "joined") {
                log.warn(`Didn't handle join for ${data.sender} as the remote ghost contains malformed UTF16, deleting ghost`);
                this.store.removeGhost(senderMatrixUser.getId(), protocol, data.sender);
                return; // Hack, just no-op joins for malformed UTF puppets
            }
            const intentUser = (typeof (data.kicker) === "string") ? protocol.getMxIdForProtocol(
                data.kicker,
                this.config.bridge.domain,
                this.config.bridge.userPrefix,
            ) : senderMatrixUser;
            const intent = this.bridge.getIntent(intentUser.userId);
            const roomId = await this.createOrGetGroupChatRoom(data, intent, true).catch((ex) => {
                log.error(`Didn't handle join for ${data.sender} -> ${ex}`);
                return;
            });
            const account = this.purple.getAccount(data.account.username, data.account.protocol_id);
            // Do we need to set a profile before we can join to avoid uglyness?
            const profileNeeded = this.config.tuning.waitOnProfileBeforeSend &&
                (!remoteUser || remoteUser!.displayname);
            try {
                if (data.state === "joined") {
                    if (this.alreadyKnownSenders.has(data.sender)) {
                        return;
                    }
                    if (!profileNeeded) {
                        await intent.join(roomId);
                    }
                    if (account) {
                        await this.profileSync.updateProfile(
                            protocol,
                            data.sender,
                            account,
                        );
                    }
                    if (profileNeeded) {
                        await intent.join(roomId);
                    }
                } else if (data.state === "kick") {
                    await intent.kick(roomId, senderMatrixUser.getId(), data.reason || undefined);
                    this.alreadyKnownSenders.delete(data.sender);
                } else if (data.state === "left") {
                    if (this.config.tuning.limitStateChanges &&
                        (!data.gatewayAlias && !data.banner && (!data.kicker || (data.kicker && data.technical)))
                    ) {
                        log.info(`No-Oping ${data.kicker ? "kick" : "leave"} for ${data.sender} as state changes are limited`);
                        return;
                    }
                    await intent.leave(roomId, data.reason || undefined);
                    this.alreadyKnownSenders.delete(data.sender);
                }
            } catch (ex) {
                log.warn("Failed to apply state change:", ex);
            }
        } catch (ex) {
            log.error("handleRemoteUserState() exception:", ex);
        }
    }

    private async handleTopic(data: IChatTopicState) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleTopic, bridge was not defined");
            }
            const intent = this.bridge.getIntent();
            log.info(`Setting topic for ${data.conv.name}: ${data.topic}`);
            const roomId = await this.createOrGetGroupChatRoom(data, intent, true, true);
            if (roomId === false) {
                log.info("Room does not support setting topic");
            }
            const state = await intent.roomState(roomId) as WeakEvent[];
            const topicEv = state.find((ev) => ev.type === "m.room.topic");
            const nameEv = state.find((ev) => ev.type === "m.room.name");
            const currentName = nameEv ? nameEv.content.name : "";
            const currentTopic = topicEv ? topicEv.content.name : "";
            if (currentTopic !== data.topic ? data.topic : "") {
                intent.setRoomTopic(roomId, data.topic || "").catch((err) => {
                    log.warn("Failed to set topic of", roomId, err);
                });
            }
            if (currentName === "") {
                intent.setRoomName(roomId, data.conv.name).catch((err) => {
                    log.warn("Failed to set name of", roomId, err);
                });
            }
        } catch (ex) {
            log.error("handleTopic() exception:", ex);
        }
    }
    private async handleRoomAvatar(data: IChatAvatarState) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleRoomAvatar, bridge was not defined");
            }
            const intent = this.bridge.getIntent();
            log.info(`Setting avatar for ${data.conv.name} (size ${data.buffer.toString().length.toString()})`);
            const roomId = await this.createOrGetGroupChatRoom(data, intent, true, true);
            if (roomId === false) {
                log.info("Room does not support setting avatar");
            }
            const state = await intent.roomState(roomId) as WeakEvent[];
            const avatarEv = state.find((ev) => ev.type === "m.room.avatar");
            const currentUrl = avatarEv ? avatarEv.content.url : "";
            if (!data.conv.avatar_type || !data.conv.avatar_type.match(/^image.*/)) {
                throw Error("Wrong mimetype or no mimetype");
            }
            log.info(`Avatar type is ${data.conv.avatar_type}`);
            // get the buffer of the current avatar
            try {
                let currentData: any;
                if (currentUrl !== "") {
                    try {
                        let res = await request.get(
                            intent.getClient().mxcUrlToHttp(currentUrl),
                            {
                                responseType: "arraybuffer",
                            },
                        );
                        currentData = Buffer.from(res.data);
                    } catch (ex) {
                        log.warn("Error retrieving current avatar, setting one new anyways ", ex)
                    }
                }
                if (!currentData || (Buffer.compare(currentData, data.buffer) !== 0)) {
                    const mxcurl = await intent.uploadContent(data.buffer, {
                        includeFilename: false,
                        type: data.conv.avatar_type,
                    });
                    intent.setRoomAvatar(roomId, mxcurl).catch((err) => {
                        log.warn("Failed to set avatar of ", roomId, err);
                    });
                } else {
                    log.info("Avatar didn't change, not setting the same avatar");
                }
            } catch (ex) {
                log.warn("Failed to process avatar ", ex);
            }
        } catch (ex) {
            log.error("handleRoomAvatar() exception:", ex);
        }
    }
    private async handleIMTyping(data: IChatTyping) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleIMTyping, bridge was not defined");
            }
            const matrixUser = await this.store.getMatrixUserForAccount(data.account);
            if (matrixUser === null) {
                return;
            }
            const roomId = await this.getIMRoomId(data, matrixUser);
            if (!roomId) {
                return;
            }
            log.debug(`Setting typing status for ${roomId} ${data.sender}: ${data.typing}`);
            const intent = this.bridge.getIntent(this.purple.getProtocol(data.account.protocol_id)!.getMxIdForProtocol(
                data.sender,
                this.config.bridge.domain,
                this.config.bridge.userPrefix,
            ).userId);
            await intent.sendTyping(roomId, data.typing);
        } catch (ex) {
            log.error("handleIMTyping() exception:", ex);
        }
    }

    private async handleChatTyping(data: IChatTyping) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleTyping, bridge was not defined");
            }
            log.debug(`Setting typing status for ${data.conv.name} ${data.sender}: ${data.typing}`);
            const intent = this.bridge.getIntent(this.purple.getProtocol(data.account.protocol_id)!.getMxIdForProtocol(
                data.sender,
                this.config.bridge.domain,
                this.config.bridge.userPrefix,
            ).userId);
            const roomId = await this.createOrGetGroupChatRoom(data, intent, true);
            await intent.sendTyping(roomId, data.typing);
        } catch (ex) {
            log.error("handleChatTyping() exception:", ex);
        }
    }

    private async handleReadReceipt(data: IChatReadReceipt) {
        try {
            if (!this.bridge) {
                throw Error("Couldn't handleTyping, bridge was not defined");
            }
            const userId = this.purple.getProtocol(data.account.protocol_id)!.getMxIdForProtocol(
                data.sender,
                this.config.bridge.domain,
                this.config.bridge.userPrefix,
            ).userId;
            const intent = this.bridge.getIntent(userId);
            const roomId = await this.createOrGetGroupChatRoom(data, intent, true);
            const eventId = data.originIsMatrix ? data.messageId : this.remoteEventIdMapping.get(data.messageId);
            if (!eventId) {
                log.info(`Got read receipt for ${data.messageId}, but no corresponding event was found`);
                return;
            }
            await intent.sendReadReceipt(roomId, eventId);
            log.debug(`Updated read reciept for ${userId} in ${roomId}`);
        } catch (ex) {
            log.error("handleReadReceipt() exception:", ex);
        }
    }

    private async handleStartup(data: any) {
        log.info("Initializing list of already known senders for startup sequence");
        try {
            this.alreadyKnownSenders = await this.store.listLocalSenderNames();
        } catch (ex) {
            log.warn("Initialization failed:", ex);
            this.alreadyKnownSenders = new Set();
        }
    }
}

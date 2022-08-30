import { IChatJoinProperties,
    IUserInfo, IConversationEvent, IChatJoined, IAccountMinimal, IStoreRemoteUser, ICleanDoppleganger } from "../bifrost/Events";
import { XmppJsInstance, XMPP_PROTOCOL } from "./XJSInstance";
import { IBifrostAccount, IChatJoinOptions } from "../bifrost/Account";
import { IBifrostInstance } from "../bifrost/Instance";
import { BifrostProtocol } from "../bifrost/Protocol";
import { jid, JID } from "@xmpp/jid";
import { IBasicProtocolMessage } from "../MessageFormatter";
import { Metrics } from "../Metrics";
import { Logging } from "matrix-appservice-bridge";
import { v4 as uuid } from "uuid";
import { XHTMLIM } from "./XHTMLIM";
import { StzaMessage, StzaIqPing, StzaPresenceJoin, StzaPresencePart, StzaIqVcardRequest } from "./Stanzas";
import { Util } from "../Util";

const IDPREFIX = "bifrost";
const CONFLICT_SUFFIX = "[m]";
const LASTSTANZA_CHECK_MS = 2 * 60000;
const LASTSTANZA_MAXDURATION = 10 * 60000;
const log = Logging.get("XmppJsAccount");

export class XmppJsAccount implements IBifrostAccount {

    get waitingJoinRoomProps(): undefined {
        return undefined;
    }

    get name(): string {
        return this.remoteId;
    }

    get protocol(): BifrostProtocol {
        return XMPP_PROTOCOL;
    }
    public readonly waitingToJoin: Set<string>;
    public readonly isEnabled = true;
    public readonly connected = true;

    public readonly roomHandles: Map<string, string>;
    public readonly roomNicks: Set<string>;
    private readonly pmSessions: Set<string>;
    private avatarHash?: string;
    private cleanedDG: number;
    private lastStanzaTs: Map<string, number>;
    private checkInterval: NodeJS.Timeout;
    constructor(
        public readonly remoteId: string,
        public readonly resource: string,
        private xmpp: XmppJsInstance,
        public readonly mxId: string,
    ) {
        this.roomHandles = new Map();
        this.roomNicks = new Set();
        this.waitingToJoin = new Set();
        this.pmSessions = new Set();
        this.cleanedDG = 0;
        this.lastStanzaTs = new Map();
        this.checkInterval = setInterval(() => {
            this.lastStanzaTs.forEach((ts, roomName) => {
                if (Date.now() - ts > LASTSTANZA_MAXDURATION) {
                    this.selfPing(roomName).then((isInRoom) => {
                        if (isInRoom) {
                            this.lastStanzaTs.set(roomName, Date.now());
                            return;
                        }
                        // make really sure the handle is not null
                        let handle: string;
                        if (!this.roomHandles.has(roomName)) {
                            log.warn(`${this.remoteId} has no handler for ${roomName}`);
                            const handleRegex = /^(.*)\/(.*)$/;
                            for (const roomNick of this.roomNicks.values()) {
                                const match = roomNick.match(handleRegex);
                                if (match && match[1] === roomName) {
                                    handle = match[2];
                                }
                                break;
                            }
                        }
                        if (this.roomHandles.get(roomName) || handle) {
                            this.joinChat({
                                fullRoomName: roomName,
                                handle: this.roomHandles.get(roomName) || handle,
                                avatar_hash: this.avatarHash,
                            });
                        }
                    });
                }
            });
        }, LASTSTANZA_CHECK_MS);
    }

    public stop() {
        clearInterval(this.checkInterval);
    }

    public xmppBumpLastStanzaTs(roomName: string) {
        this.lastStanzaTs.set(roomName, Date.now());
    }

    public createNew(password?: string) {
        throw Error("Xmpp.js doesn't support registering accounts");
    }

    public setEnabled(enable: boolean) {
        throw Error("Xmpp.js doesn't allow you to enable or disable accounts");
    }

    public sendIM(recipient: string, msg: IBasicProtocolMessage) {
        msg.id = msg.id || IDPREFIX + Date.now().toString();
        // Check if the recipient is a gateway user, because if so we need to do some fancy masking.
        const res = this.xmpp.gateway ? this.xmpp.gateway.maskPMSenderRecipient(this.mxId, recipient) : null;
        let sender = `${this.remoteId}/${this.resource}`;
        if (res) {
            recipient = res.recipient;
            sender = res.sender;
        }
        log.debug(`IM ${sender} -> ${recipient}`);
        const message = new StzaMessage(
            sender,
            recipient,
            msg,
            "chat",
        );
        if (!this.pmSessions.has(recipient)) {
            this.pmSessions.add(recipient);
        }
        this.xmpp.xmppAddSentMessage(message);
        this.xmpp.xmppSend(message);
        Metrics.remoteCall("xmpp.message.chat");
    }

    public sendChat(chatName: string, msg: IBasicProtocolMessage) {
        const id = msg.id || IDPREFIX + Date.now().toString();
        if (msg.formatted && msg.formatted.length) {

            msg.formatted.forEach(
                (f) => { if (f.type === "html") { f.body = XHTMLIM.HTMLToXHTML(f.body); } },
            );
        }
        const xMsg = new StzaMessage(`${this.remoteId}/${this.resource}`, chatName, msg, "groupchat");
        if (msg.id) {
            // Send RR for message if we have the matrixId.
            this.xmpp.emitReadReciepts(msg.id, chatName, true);
        }
        this.xmpp.xmppAddSentMessage(xMsg);
        this.xmpp.xmppSend(xMsg);
        Metrics.remoteCall("xmpp.message.groupchat");
    }

    public getBuddy(user: string): any|undefined {
        // TODO: Not implemented
        return;
    }

    public getJoinPropertyForRoom(roomName: string, key: string): string|undefined {
        // TODO: Not implemented
        return;
    }

    public setJoinPropertiesForRoom(roomName: string, props: IChatJoinProperties) {
        // TODO: Not implemented
    }

    public isInRoom(roomName: string): boolean {
        const handle = this.roomHandles.get(roomName);
        if (!handle) {
            return false;
        }
        const res = this.xmpp.presenceCache.getStatus(roomName + "/" + handle);
        log.debug("isInRoom: Got presence for user:", res, this.remoteId);
        if (!res) {
            return false;
        }
        return res.online;
    }

    public async selfPing(to: string): Promise<boolean> {
        const id = uuid();
        log.debug(`Self-pinging ${to}`);
        const pingStanza = new StzaIqPing(
            `${this.remoteId}/${this.resource}`,
            to,
            id,
            "get",
        );
        Metrics.remoteCall("xmpp.iq.ping");
        try {
            await this.xmpp.sendIq(pingStanza);
            return true;
        }
        catch (ex) {
            return false;
        }
    }

    public reconnectToRooms() {
        log.info("Recovering rooms for", this.remoteId);
        this.roomHandles.forEach(async (handle, fullRoomName) => {
            try {
                log.debug("Rejoining", fullRoomName);
                await this.joinChat({
                    handle: handle,
                    fullRoomName: fullRoomName,
                    avatar_hash: this.avatarHash,
                });
            } catch (ex) {
                log.warn(`Failed to rejoin ${fullRoomName}`, ex);
            }
        });
    }

    public async rejoinChat(fullRoomName: string) {
        log.info(`Rejoining ${fullRoomName} for ${this.remoteId}`);
        try {
            const handle = this.roomHandles.get(fullRoomName);
            if (!handle) {
                throw new Error("User has no assigned handle for this room, we cannot rejoin!");
            }
            // we need to clean handles before attempting to rejoin
            this.cleanedDG = 0;
            this.roomHandles.delete(fullRoomName);
            this.roomNicks.delete(`${fullRoomName}/${handle}`);
            await this.joinChat({
                handle: handle,
                fullRoomName: fullRoomName,
                avatar_hash: this.avatarHash,
            });
        } catch (ex) {
            log.warn(`Failed to rejoin ${fullRoomName}`, ex);
        }
    }

    public async joinChat(
        components: IChatJoinProperties,
        instance?: IBifrostInstance,
        timeout: number = 60000,
        setWaiting: boolean = true)
        : Promise<IConversationEvent|void> {
        if (!components.fullRoomName && (!components.room || !components.server)) {
            throw Error("Missing fullRoomName OR room|server");
        }
        if (!components.handle) {
            throw Error("Missing handle");
        }
        const roomName = components.fullRoomName || `${components.room}@${components.server}`;
        let to = `${roomName}/${components.handle}`;
        const from = `${this.remoteId}/${this.resource}`;
        log.debug(`joinChat:`, this.remoteId, components);
        if (this.isInRoom(roomName)) {
            const currentHandle = this.roomHandles.get(roomName);
            if (currentHandle !== components.handle) {
                log.debug(`Leaving ${to} with old puppet ${currentHandle}`);
                this.cleanedDG = 0;
                this.cleanDG(to, roomName);
                await this.rejectChat(
                    {
                        fullRoomName: components.fullRoomName,
                        room: components.room,
                        server: components.server,
                    } as IChatJoinProperties
                );
                if (!Util.resourcePrep(components.handle)) {
                    log.debug(`Rejoining ${to} with ${this.mxId} as nick as the Handle contained invalid characters`);
                    await this.joinChat(
                        {
                            handle: this.mxId,
                            fullRoomName: roomName,
                            avatar_hash: components.avatar_hash || this.avatarHash,
                        } as IChatJoinProperties
                    );
                    return;
                }
            } else {
                log.debug(`Didn't join ${to} from ${from}, already joined`);
                this.cleanDG(to, roomName);
                return {
                    eventName: "already-joined",
                    account: {
                        username: this.remoteId,
                        protocol_id: XMPP_PROTOCOL.id,
                    } as IAccountMinimal,
                    conv: {
                        name: roomName,
                    },
                };
            }
        }
        if (await this.selfPing(to)) {
            log.info(`Didn't join ${to} from ${from}, self ping says we are joined`);
            this.roomHandles.set(roomName, components.handle);
            this.roomNicks.add(to);
            this.cleanDG(to, roomName);
            return {
                eventName: "already-joined",
                account: {
                    username: this.remoteId,
                    protocol_id: XMPP_PROTOCOL.id,
                } as IAccountMinimal,
                conv: {
                    name: roomName,
                },
            };
        }
        log.info(`Joining to=${to} from=${from}`);
        const message = new StzaPresenceJoin(
            from,
            to,
            null,
            null,
            components.avatar_hash,
        );
        this.roomHandles.set(roomName, components.handle);
        this.roomNicks.add(to);
        this.avatarHash = components.avatar_hash;
        if (setWaiting) {
            this.waitingToJoin.add(roomName);
        }
        let p: Promise<IChatJoined>|undefined;
        if (instance) {
            p = new Promise((resolve, reject) => {
                const timer = setTimeout(reject, timeout);
                const cb = (data: IChatJoined) => {
                    if (data.conv.name === roomName) {
                        this.waitingToJoin.delete(roomName);
                        log.info(`Got ack for join ${roomName}`);
                        this.cleanDG(to, roomName);
                        clearTimeout(timer);
                        this.xmpp.removeListener("chat-joined", cb);
                        resolve(data);
                    }
                };
                this.xmpp.on("chat-joined", cb);
            });
        }
        // To catch out races, we will emit this first.
        this.xmpp.emit("store-remote-user", {
            mxId: this.mxId,
            remoteId: to,
            protocol_id: XMPP_PROTOCOL.id,
        } as IStoreRemoteUser);
        await this.xmpp.xmppSend(message);
        Metrics.remoteCall("xmpp.presence.join");
        return p;
    }

    public async xmppRetryJoin(from: JID) {
        log.info("Retrying join for ", from.toString());
        if (from.resource.endsWith(CONFLICT_SUFFIX)) {
            // Kick from the room.
            throw new Error(`A user with the prefix '${CONFLICT_SUFFIX}' already exists, cannot join to room.`);
        }
        return this.joinChat({
            room: from.local,
            server: from.domain,
            handle: `${from.resource}${CONFLICT_SUFFIX}`,
            avatar_hash: this.avatarHash,
        });
    }

    public async rejectChat(components: IChatJoinProperties) {
        /** This also handles leaving */
        const room = components.fullRoomName || `${components.room}@${components.server}`;
        components.handle = this.roomHandles.get(room)!;
        log.info(`${this.remoteId} (${components.handle}) is leaving ${room}`);

        await this.xmpp.xmppSend(new StzaPresencePart(
            `${this.remoteId}/${this.resource}`,
            `${room}/${components.handle}`,
        ));
        this.roomHandles.delete(room);
        this.roomNicks.delete(`${room}/${components.handle}`);
        Metrics.remoteCall("xmpp.presence.left");
    }

    public getConversation(name: string): any {
        throw Error("getConversation not implemented");
    }

    public getChatParamsForProtocol(): IChatJoinOptions[] {
        return [
            {
                identifier: "server",
                label: "server",
                required: true,
            },
            {
                identifier: "room",
                label: "room",
                required: true,
            },
            {
                identifier: "handle",
                label: "handle",
                required: false,
            },
        ];
    }

    public async getUserInfo(who: string): Promise<IUserInfo> {
        const j = jid(who);
        const status = this.xmpp.presenceCache.getStatus(who);
        const ui: IUserInfo = {
            Nickname: j.resource || j.local,
            eventName: "meh",
            who,
            account: {
                protocol_id: this.protocol.id,
                username: this.remoteId,
            },
        };
        if (status && status.photoId) {
            ui.Avatar = status.photoId;
        }
        return ui;
    }

    public async getAvatarBuffer(iconPath: string, senderId: string): Promise<{type: string, data: Buffer}> {
        log.info(`Fetching avatar for ${senderId} (hash: ${iconPath})`);
        const vCard = await this.xmpp.getVCard(senderId);
        const photo = vCard.getChild("PHOTO");
        if (!photo) {
            throw Error("No PHOTO in vCard given");
        }
        return {
            data: Buffer.from(
                photo.getChildText("BINVAL")!,
                "base64",
            ),
            type: photo!.getChildText("TYPE") || "image/jpeg",
        };

    }

    public setStatus() {
        // No-op
        return;
    }

    public sendIMTyping() {
        // No-op
        return;
    }

    private cleanDG(to: string, roomName: string) {
        if (this.cleanedDG >= 10) {
            return;
        }
        this.xmpp.emit("clean-remote-doppleganger", {
            sender: to,
            protocol: this.xmpp.getProtocol(XMPP_PROTOCOL.id),
            roomName,
        } as ICleanDoppleganger);
        this.cleanedDG++;
    }
}

import { XmppJsInstance, XMPP_PROTOCOL } from "./XJSInstance";
import { Element, x } from "@xmpp/xml";
import parse from "@xmpp/xml/lib/parse";
import { jid, JID } from "@xmpp/jid";
import { Bridge, Logging } from "matrix-appservice-bridge";
import { IConfigBridge } from "../Config";
import { IBasicProtocolMessage } from "../MessageFormatter";
import {
    IGatewayJoin,
    IUserStateChanged,
    IStoreRemoteUser,
    IUserInfo
} from "../bifrost/Events";
import { IGatewayRoom } from "../bifrost/Gateway";
import { PresenceCache } from "./PresenceCache";
import { XHTMLIM } from "./XHTMLIM";
import { BifrostRemoteUser } from "../store/BifrostRemoteUser";
import { StzaPresencePhoto, StzaPresenceItem, StzaMessage, StzaMessageSubject,
    StzaPresenceError, StzaBase, StzaPresenceKick, PresenceAffiliation, PresenceRole } from "./Stanzas";
import { IGateway } from "../bifrost/Gateway";
import { GatewayMUCMembership, IGatewayMemberXmpp, IGatewayMemberMatrix } from "./GatewayMUCMembership";
import { XMPPStatusCode } from "./XMPPConstants";
import { AutoRegistration } from "../AutoRegistration";
import { GatewayStateResolve } from "./GatewayStateResolve";
import { MatrixMembershipEvent } from "../MatrixTypes";
import { IHistoryLimits, HistoryManager, MemoryStorage } from "./HistoryManager";
import { Util } from "../Util";
import { ProtoHacks } from "../ProtoHacks";

const REGEXP_MXC = /^mxc:\/\/.*/;
const log = Logging.get("XmppJsGateway");

export interface RemoteGhostExtraData {
    rooms: {
        [chatName: string]: {devices: string[], jid: string}
    }
}

/**
 * This class effectively implements a MUC that sits in between the gateway interface
 * and XMPP.
 */
export class XmppJsGateway implements IGateway {
    // For storing room history
    private roomHistory: HistoryManager;
    // For storing room vcard hashes
    private hashesCache: Map<string, string>; // chatName -> hash
    // For storing requests to be responded to, like joins
    private stanzaCache: Map<string, Element>; // id -> stanza
    private presenceCache: PresenceCache;
    // Storing every XMPP user and their anonymous.
    private members: GatewayMUCMembership;
    constructor(private xmpp: XmppJsInstance, private registration: AutoRegistration, private config: IConfigBridge, private bridge: Bridge) {
        this.roomHistory = new HistoryManager(new MemoryStorage(50));
        this.hashesCache = new Map();
        this.stanzaCache = new Map();
        this.members = new GatewayMUCMembership();
        this.presenceCache = new PresenceCache(true);
    }

    public handleStanza(stanza: Element, gatewayAlias: string) {
        const delta = this.presenceCache.add(stanza);
        if (!delta) {
            log.debug("No delta");
            return;
        }
        const to = jid(stanza.attrs.to);
        const convName = Util.prepJID(to);
        const isMucType = stanza.getChildByAttr("xmlns", "http://jabber.org/protocol/muc");
        log.info(`Handling ${stanza.name} from=${stanza.attrs.from} to=${stanza.attrs.to} for ${gatewayAlias}`);
        if ((delta.changed.includes("online") || delta.changed.includes("newdevice")) && isMucType) {
            const id = stanza.attrs.id || this.xmpp.generateIdforMsg(stanza);
            this.addStanzaToCache(stanza, id);
            // Gateways are special.
            // We also want to drop the resource from the sender.
            const sender = Util.prepJID(jid(stanza.attrs.from));
            this.xmpp.emit("gateway-joinroom", {
                join_id: id,
                roomAlias: gatewayAlias,
                sender,
                nick: to.resource,
                protocol_id: XMPP_PROTOCOL.id,
                room_name: convName,
            } as IGatewayJoin);
        } else if (delta.changed.includes("newnick") && !isMucType) {
            // Bounce nick changes from Gateway
            this.xmpp.xmppSend(
                new StzaPresenceError(
                    stanza.attrs.to, stanza.attrs.from, stanza.attrs.id,
                    gatewayAlias, "cancel", "not-acceptable", "Nick changes are not allowed Gateway side, please part and rejoin the room",
                )                
            );
        } else if (delta.changed.includes("offline")) {
            const wasBanned = delta.status!.ban;
            let banner: string|boolean|undefined;
            if (wasBanned && wasBanned.banner) {
                banner = `${convName}/${wasBanned.banner}`;
            } else if (wasBanned) {
                banner = true;
            }
            const wasKicked = delta.status!.kick;
            let kicker: string|boolean|undefined;
            let technical: boolean|undefined;
            if (wasKicked && wasKicked.kicker) {
                kicker = `${convName}/${wasKicked.kicker}`;
            } else if (wasKicked) {
                kicker = true;
            }
            let reason: string|undefined;
            if (wasBanned) {
                reason = wasBanned.reason;
            } else if (wasKicked) {
                reason = wasKicked.reason;
                technical = wasKicked.technical;
            }
            const member = this.members.getXmppMemberByDevice(convName, stanza.attrs.from);
            const lastDevice = this.remoteLeft(stanza);
            if (!member) {
                log.warn("User has gone offline, but we don't have a member for them");
                return;
            }
            if (!lastDevice) {
                // User still has other devices, not leaving.
                log.info(`User has ${member.devices.size} other devices, not leaving.`);
                return;
            }
            this.xmpp.emit("chat-user-left", {
                conv: {
                    name: convName,
                },
                account: {
                    protocol_id: XMPP_PROTOCOL.id,
                    username: convName,
                },
                sender: member.realJid.toString(),
                state: "left",
                banner,
                kicker,
                technical,
                reason: reason || delta.status!.status,
                gatewayAlias,
            } as IUserStateChanged);
        } else {
            log.debug("Nothing to do");
        }
    }

    public addStanzaToCache(stanza: Element, id: string) {
        this.stanzaCache.set(id, stanza);
        log.debug("Added cached stanza for " + id);
    }

    public getMembersInRoom(chatName: string) {
        return this.members.getMembers(chatName);
    }

    public memberInRoom(chatName: string, matrixId: string) {
        return !!this.members.getXmppMemberByMatrixId(chatName, matrixId);
    }

    public isJIDInMuc(chatName: string, j: JID) {
        return !!this.members.getXmppMemberByDevice(chatName, j);
    }

    public getMatrixIDForJID(chatName: string, j: JID) {
        const user = this.members.getMemberByAnonJid<IGatewayMemberMatrix>(chatName, j.toString());
        if (!user) {
            return false;
        }
        log.debug(`Got ${user.matrixId} for ${chatName}`);
        return user.matrixId;
    }

    public getAnonIDForJID(chatName: string, j: JID): string|null {
        const member = this.members.getXmppMemberByRealJid(chatName, j.toString());
        if (member) {
            return member.anonymousJid.toString();
        }
        return null;
    }

    public async sendMatrixMessage(
        chatName: string, sender: string, msg: IBasicProtocolMessage, room: IGatewayRoom) {
        try {
            await this.updateMatrixMemberListForRoom(chatName, room);
            log.info(`Sending ${msg.id} to ${chatName}`);
            const from = this.members.getMatrixMemberByMatrixId(chatName, sender);
            if (!from) {
                log.error(`Cannot send ${msg.id}: No member cached.`);
                return;
            }
            let msgIdAdded: boolean;

            // Ensure that the html portion is XHTMLIM
            if (msg.formatted) {
                msg.formatted!.forEach((fmt) => {
                    if (fmt.type === "html") {
                        fmt.body = XHTMLIM.HTMLToXHTML(fmt.body);
                    }
                });
            }
            const msgs = [...this.members.getXmppMembersDevices(chatName)].map((device) => {
                const stanza = new StzaMessage(
                    msg.redacted?.moderation ? chatName : from.anonymousJid.toString(),
                    device,
                    msg,
                    "groupchat",
                );
                if (!msg.redacted) {
                    stanza.stanzaId = msg.id
                }
                if (!msgIdAdded) {
                    msgIdAdded = true;
                    this.xmpp.xmppAddSentMessage(stanza);
                }
                return stanza;
            });

            // add the message to the room history
            const historyStanza = new StzaMessage(
                msg.redacted?.moderation ? chatName : from.anonymousJid.toString(),
                "",
                msg,
                "groupchat",
            );
            historyStanza.stanzaId = !msg.redacted ? msg.id : undefined;
            if (room.allowHistory) {
                this.roomHistory.addMessage(chatName, parse(historyStanza.xml),
                    msg.redacted?.moderation ? from.anonymousJid.bare() : from.anonymousJid);
            }

            return this.xmpp.xmppSendBulk(msgs);
        } catch (ex) {
            log.error("sendMatrixMessage() Exception:", ex);
        }
    }

    /**
     * Send a XMPP message to the occupants of a gateway.
     *
     * @param chatName The XMPP MUC name
     * @param stanza The XMPP stanza message
     * @returns If the message was sent successfully.
     */
    public async reflectXMPPMessage(chatName: string, stanza: Element, kickNonMember = true): Promise<boolean> {
        try {
            const member = this.members.getXmppMemberByRealJid(chatName, stanza.attrs.from);
            if (!member && kickNonMember) {
                log.warn(`${stanza.attrs.from} is not part of this room.`);
                // Send the sender an error.
                const kick = new StzaPresenceKick(
                    stanza.attrs.to,
                    stanza.attrs.from,
                );
                kick.statusCodes.add(XMPPStatusCode.SelfPresence);
                kick.statusCodes.add(XMPPStatusCode.SelfKicked);
                kick.statusCodes.add(XMPPStatusCode.SelfKickedTechnical);
                await this.xmpp.xmppSend(kick);
                return false;
            }
            const preserveFrom = stanza.attrs.from;
            try {
                stanza.attrs.from = member!.anonymousJid;
                const devices = this.members.getXmppMembersDevices(chatName);
                for (const deviceJid of devices) {
                    stanza.attrs.to = deviceJid;
                    this.xmpp.xmppWriteToStream(stanza);
                }
            } catch (err) {
                log.warn("Failed to reflect XMPP message:", err);
                stanza.attrs.from = preserveFrom;
                return false;
            }
            stanza.attrs.from = preserveFrom;
            try {
                // TODO: Currently we have no way to determine if this room has private history,
                // so we may be adding more strain to the cache than nessacery.
                this.roomHistory.addMessage(
                    chatName, stanza,
                    member.anonymousJid,
                );
            } catch (ex) {
                log.warn(`Failed to add message for ${chatName} to history cache`);
            }
            return true;
        } catch (ex) {
            log.error("reflectXMPPMessage() Exception:", ex);
        }
    }

    public reflectXMPPStanza(chatName: string, stanza: StzaBase) {
        const xmppDevices = [...this.members.getXmppMembersDevices(chatName)];
        return Promise.all(xmppDevices.map((device) => {
            stanza.to = device;
            return this.xmpp.xmppSend(stanza);
        }));
    }

    public reflectPM(stanza: Element) {
        const to = jid(stanza.attrs.to);
        const convName = Util.prepJID(to);
        // This is quite easy..
        const sender = this.members.getXmppMemberByRealJid(convName, stanza.attrs.from);
        if (!sender) {
            log.error("Cannot find sender in memberlist for PM");
            return;
        }
        const recipient = this.members.getMemberByAnonJid<IGatewayMemberXmpp>(convName, stanza.attrs.to);
        if (!recipient) {
            log.error("Cannot find recipient in memberlist for PM");
            return;
        }
        stanza.attrs.from = sender.anonymousJid.toString();
        for (const device of recipient.devices) {
            stanza.attrs.to = device;
            log.info(`Reflecting PM message ${stanza.attrs.from} -> ${stanza.attrs.to}`);
            this.xmpp.xmppWriteToStream(stanza);
        }
    }

    public async sendMatrixMembership(
        chatName: string, event: MatrixMembershipEvent, room: IGatewayRoom, rename: boolean = false
    ) {
        try {
            log.info(`Got new ${event.content.membership} for ${event.state_key} (from: ${event.sender}) in ${chatName}`);
            // Iterate around each joined member and add the new presence step.
            const presenceEvents = GatewayStateResolve.resolveMatrixStateToXMPP(chatName, this.members, event, room, rename);
            if (presenceEvents.length === 0) {
                log.info(`Nothing to do for ${event.event_id}`);
                return;
            }
            await this.xmpp.xmppSendBulk(presenceEvents);
        } catch (ex) {
            log.error("sendMatrixMembership() Exception:", ex);
        }
    }

    public sendStateChange(
        chatName: string, sender: string, type: "topic"|"name"|"avatar", room: IGatewayRoom,
    ) {
        log.info(`Got new ${type} for ${sender} in ${chatName}`);
        // Iterate around each joined member and add the new presence step.
        const users = this.members.getXmppMembers(chatName);
        if (users.length === 0) {
            log.warn("No users found for gateway room!");
        }
        if (type !== "topic" && type !== "name") {
            this.hashesCache.set(chatName, room.avatar);
            this.reflectXMPPStanza(chatName,
                new StzaPresencePhoto(chatName, "", "room-avatar", null, room.avatar)
            );
            return;
        }
        this.reflectXMPPStanza(chatName,
            new StzaMessageSubject(chatName, "", undefined,
                `${room.name || ""} ${room.topic ? "| " + room.topic : ""}`,
            ));
    }

    public getMxidForRemote(sender: string) {
        const j = jid(sender);
        const username = Util.prepJID(j);
        return XMPP_PROTOCOL.getMxIdForProtocol(username, this.config.domain, this.config.userPrefix).getId();
    }

    public async onRemoteJoin(
        err: string|null, joinId: string, room: IGatewayRoom|undefined, ownMxid: string|undefined,
    ) {
        try {
            const startTs = Date.now();
            log.debug("Handling remote join for " + joinId);
            const stanza = this.stanzaCache.get(joinId);
            this.stanzaCache.delete(joinId);
            if (!stanza) {
                log.error("Could not find stanza in cache for remoteJoin. Cannot handle");
                throw Error("Stanza for join not in cache, cannot handle");
            }
            const from = jid(stanza.attrs.from);
            const to = jid(stanza.attrs.to);
            const chatName = Util.prepJID(to);

            if (err) {
                const presenceStatus = this.presenceCache.getStatus(stanza.attrs.from);
                if (presenceStatus) {
                    presenceStatus.online = false;
                    this.presenceCache.modifyStatus(stanza.attrs.from, presenceStatus);
                }
                log.warn("Responding with an error to remote join:", err);
                // XXX: Specify the actual failure reason.
                this.xmpp.xmppSend(new StzaPresenceError(
                    stanza.attrs.to, stanza.attrs.from, stanza.attrs.id,
                    chatName, "cancel", "service-unavailable", err,
                ));
                return;
            }
            room = room!;

            if (!ownMxid) {
                throw Error('ownMxid is not defined');
            }

            // Ensure our membership is accurate.
            await this.updateMatrixMemberListForRoom(chatName, room, true); // HACK: Always update members for joiners
            // Check if the nick conflicts.
            const existingMember = this.members.getMemberByAnonJid(chatName, stanza.attrs.to);
            if (existingMember) {
                if (existingMember.type === "matrix") {
                    log.error("Conflicting nickname, not joining");
                    this.xmpp.xmppSend(new StzaPresenceError(
                        stanza.attrs.to, stanza.attrs.from, stanza.attrs.id,
                        chatName, "cancel", "conflict",
                    ));
                    throw Error("Conflicting nickname, not joining");
                }
                const existingXmppMember = existingMember as IGatewayMemberXmpp;
                const existingUserId = Util.prepJID(existingXmppMember.realJid!);
                const currentUserId = Util.prepJID(from);
                if (existingXmppMember.devices.has(stanza.attrs.from)) {
                    log.debug("Existing device has requested a join");
                    // An existing device has reconnected, so fall through here.
                } else if (existingUserId === currentUserId) {
                    log.debug(`${currentUserId} is joining from a new device ${from.resource}`);
                } else {
                    // Different user after the same nick, heck them.
                    log.error("Conflicting nickname, not joining");
                    this.xmpp.xmppSend(new StzaPresenceError(
                        stanza.attrs.to, stanza.attrs.from, stanza.attrs.id,
                        chatName, "cancel", "conflict",
                    ));
                    throw Error("Conflicting nickname, not joining");
                }
            }

            /* Critical section - We need to emit membership to the user, but
               we can't store they are joined yet.
               https://github.com/matrix-org/matrix-bifrost/issues/132
             */

            // https://xmpp.org/extensions/xep-0045.html#order
            // 1. membership of others.
            log.debug('Emitting membership of other users');
            // Ensure we chunk this
            const allMembershipPromises: Promise<unknown>[] = [];
            for (const member of this.members.getMembers(chatName)) {
                if (member.anonymousJid.toString() === stanza.attrs.to) {
                    continue;
                }
                allMembershipPromises.push((async () => {
                    let realJid;
                    let avatarHash;
                    if ((member as IGatewayMemberXmpp).realJid) {
                        realJid = (member as IGatewayMemberXmpp).realJid.toString();
                    } else {
                        realJid = this.registration.generateParametersFor(
                            XMPP_PROTOCOL.id, (member as IGatewayMemberMatrix).matrixId,
                        ).username;
                        if (!(member as IGatewayMemberMatrix).avatarHash?.match(REGEXP_MXC)) {
                            avatarHash = (member as IGatewayMemberMatrix).avatarHash;
                        }
                    }
                    return this.xmpp.xmppSend(
                        new StzaPresenceItem(
                            member.anonymousJid.toString(),
                            stanza.attrs.from,
                            undefined,
                            PresenceAffiliation.Member,
                            PresenceRole.Participant,
                            false,
                            realJid,
                            null,
                            avatarHash,
                        ),
                    )
                })());
            }

            // Wait for all presence to be sent first.
            await Promise.all(allMembershipPromises);

            // get vcard hash
            const selfHash = stanza.getChild("x", "vcard-temp:x:update")?.getChildText("photo");

            // send room vcard hash
            const roomHash = await this.getRoomAvatarHash(chatName);
            if (roomHash) {
                await this.xmpp.xmppSend(new StzaPresencePhoto(chatName, stanza.attrs.from, "room-avatar", null, roomHash));
            }

            log.debug("Emitting membership of self");
            // 2. Send everyone else the users new presence.
            const reflectedPresence = new StzaPresenceItem(
                stanza.attrs.to,
                "",
                undefined,
                PresenceAffiliation.Member,
                PresenceRole.Participant,
                false,
                stanza.attrs.from,
                null,
                selfHash,
            );
            await this.reflectXMPPStanza(chatName, reflectedPresence);
            // FROM THIS POINT ON, WE CONSIDER THE USER JOINED.

            // 3. Send the user self presence
            const selfPresence = new StzaPresenceItem(
                stanza.attrs.to,
                stanza.attrs.from,
                stanza.attrs.id,
                PresenceAffiliation.Member,
                PresenceRole.Participant,
                true,
                null,
                null,
                selfHash,
            );

            // Matrix is non-anon, and Matrix logs.
            selfPresence.statusCodes.add(XMPPStatusCode.RoomNonAnonymous);
            selfPresence.statusCodes.add(XMPPStatusCode.RoomLoggingEnabled);
            await this.xmpp.xmppSend(selfPresence);


            this.members.addXmppMember(
                Util.prepJID(to),
                from,
                to,
                ownMxid,
            );

            // 4. Room history
            if (room.allowHistory) {
                log.debug("Emitting history");
                const historyLimits: IHistoryLimits = {};
                const historyRequest = stanza.getChild("x", "http://jabber.org/protocol/muc")?.getChild("history");
                if (historyRequest !== undefined) {
                    const getIntValue = (str) => {
                        if (!/^\d+$/.test(str)) {
                            throw new Error("Not a number");
                        }
                        return parseInt(str);
                    };
                    const getDateValue = (str) => {
                        const val = new Date(str);
                        // TypeScript doesn't like giving a Date to isNaN, even though it
                        // works.  And it doesn't like converting directly to number.
                        if (isNaN(val as unknown as number)) {
                            throw new Error("Not a date");
                        }
                        return val;
                    };
                    const getHistoryParam = (name: string, parser: (str: string) => any): void => {
                        const param = historyRequest.getAttr(name);
                        if (param !== undefined) {
                            try {
                                historyLimits[name] = parser(param);
                            } catch (e) {
                                log.debug(`Invalid ${name} in history management: "${param}" (${e})`);
                            }
                        }
                    };
                    getHistoryParam("maxchars", getIntValue);
                    getHistoryParam("maxstanzas", getIntValue);
                    getHistoryParam("seconds", getIntValue);
                    getHistoryParam("since", getDateValue);
                } else {
                    // default to 20 stanzas if the client doesn't specify
                    historyLimits.maxstanzas = 20;
                }
                const history: Element[] = await this.roomHistory.getHistory(chatName, historyLimits);
                history.forEach((e) => {
                    e.attrs.to = stanza.attrs.from;
                    this.xmpp.xmppWriteToStream(e);
                });
            } else {
                log.debug("Not emitting history, room does not have visibility turned on");
            }

            log.debug("Emitting subject");
            // 5. The room subject
            this.xmpp.xmppSend(new StzaMessageSubject(chatName, stanza.attrs.from, undefined,
                `${room.name || ""} ${room.topic ? "| " + room.topic : ""}`,
            ));


            // All done, now for some house cleaning.
            // Store this user so we can reconnect them on restart.
            this.upsertXMPPUser(from, ownMxid);
            log.debug(`Join complete for ${to}. Took ${Date.now() - startTs}ms`);
        } catch (ex) {
            log.error("Remote Join Handler Exception:", ex);
        }
    }

    private upsertXMPPUser(realJid: JID, mxId: string) {
        const rooms = this.members.getAnonJidsForXmppJid(realJid);
        const realJidStripped = Util.prepJID(realJid);

        this.xmpp.emit("store-remote-user", {
            mxId,
            remoteId: realJidStripped,
            protocol_id: XMPP_PROTOCOL.id,
            data: {
                rooms,
            },
        } as IStoreRemoteUser);
        log.debug(`Upserted XMPP user ${realJidStripped} ${realJidStripped}`);
    }

    public async initialMembershipSync(chatName: string, room: IGatewayRoom, ghosts: BifrostRemoteUser[]) {
        try {
            log.info(`Adding initial synced member list to ${chatName}`);
            await this.updateMatrixMemberListForRoom(chatName, room);
            for (const xmppUser of ghosts) {
                log.debug(`Connecting ${xmppUser.id} to ${chatName}`);
                const extraData = xmppUser.extraData as RemoteGhostExtraData;
                if (!extraData.rooms) {
                    log.debug("Didn't connect, no data");
                    return;
                }
                const roomData = extraData.rooms[chatName];
                if (!roomData) {
                    log.warn(`No information stored for ${xmppUser.id} to ${chatName}`);
                    return;
                }
                roomData.devices.forEach((device: string) => this.members.addXmppMember(
                    chatName,
                    jid(device),
                    jid(roomData.jid),
                    xmppUser.id,
                ));
            }
        } catch (ex) {
            log.error("initialMembershipSync() Exception:", ex);
        }
    }

    public async getUserInfo(who: string, nick?: string): Promise<IUserInfo> {
        const j = jid(who);
        let nickname = nick || j.resource || j.local;
        let photo: string|undefined;
        try {
            const res = await this.xmpp.getVCard(who) as Element;
            nickname = res.getChild("NICKNAME")?.getText() || nickname;
            const photoElement = res.getChild("PHOTO");
            if (photoElement) {
                photo = `${photoElement.getChildText("TYPE")}|${photoElement.getChildText("BINVAL")}`;
            }
        } catch (ex) {
            log.warn("Failed to fetch VCard", ex);
        }
        const ui: IUserInfo = {
            Nickname: nickname,
            Avatar: photo,
            eventName: "meh",
            who,
            account: {
                protocol_id: "",
                username: "",
            },
        };
        return ui;
    }

    public async getAvatarBuffer(uri: string, senderId: string): Promise<{ type: string; data: Buffer; }> {
        try {
            // The URI is the base64 value of the data prefixed by the type.
            const [type, dataBase64] = uri.split("|");
            if (!type || !type.includes("/") || !dataBase64) {
                throw Error("Avatar uri was malformed");
            }
            const data = Buffer.from(dataBase64, "base64");
            return { type, data };
        } catch (ex) {
            log.error("Encountered Exception while fetching Avatar's buffer:", ex);
        }
    }

    public maskPMSenderRecipient(senderMxid: string, recipientJid: string)
        : { recipient: string, sender: string } | undefined {
        try {
            const j = jid(recipientJid);
            const convName = Util.prepJID(j);
            log.info("Looking up possible gateway:", senderMxid, recipientJid, convName);
            const recipient = this.members.getMemberByAnonJid<IGatewayMemberXmpp>(convName, recipientJid);
            if (!recipient) {
                return undefined;
            }
            const sender = this.members.getMatrixMemberByMatrixId(convName, senderMxid);
            if (!sender) {
                log.warn("Couldn't get sender's mxid");
                throw Error("Couldn't find the senders anonymous jid for a MUC PM over the gateway");
            }
            return {
                recipient: recipient.devices[recipient.devices.size - 1].toString(),
                sender: sender.anonymousJid.toString(),
            };
        } catch (ex) {
            log.error("Encountered Exception while processing PM sender recipient:", ex);
        }
    }

    private async getRoomAvatarHash(chatName: string) {
        if (this.hashesCache.has(chatName)) {
            return this.hashesCache.get(chatName);
        }
        try {
            const alias = this.xmpp.serviceHandler.parseAliasFromJID(jid(chatName));
            const room = await this.xmpp.serviceHandler.queryRoom(alias) as any;
            if (room.roomAvatar !== "") {
                const hash = await ProtoHacks.getAvatarHash(room.roomId, room.roomAvatar, this.bridge.getIntent());
                this.hashesCache.set(chatName, hash);
                return hash;
            }
            return null;
        } catch (ex) {
            return null;
        }
    }

    private async updateMatrixMemberListForRoom(chatName: string, room: IGatewayRoom, allowForJoin = false) {
        try {
            if (!allowForJoin && this.members.getMatrixMembers(chatName).length !== 0) {
                return;
            }
            let joined = 0;
            let left = 0;
            for (const member of room.membership) {
                if (member.isRemote) {
                    continue;
                }
                if (member.membership === "join") {
                    joined++;
                    let avatarHash: string = member.avatar_hash ? member.avatar_hash as string : null;
                    if (avatarHash?.match(REGEXP_MXC)) {
                        avatarHash = await ProtoHacks.getAvatarHash(member.stateKey, (member.avatar_hash ? member.avatar_hash as string : null), this.bridge.getIntent());
                        if (avatarHash) {
                            const idx = room.membership.findIndex((entry) => entry.avatar_hash === member.avatar_hash);
                            room.membership[idx].avatar_hash = avatarHash;
                        }
                    }
                    this.members.addMatrixMember(
                        chatName,
                        member.stateKey,
                        jid(`${chatName}/${Util.resourcePrep(member.displayname) || member.stateKey}`),
                        avatarHash,
                    );
                } else if (member.membership === "leave") {
                    left++;
                    this.members.removeMatrixMember(
                        chatName,
                        member.stateKey,
                    );
                }
            }
            log.info(`Updating membership for ${chatName} ${room.roomId} j:${joined} l:${left}`);
        } catch (ex) {
            log.error("updateMatrixMemberListForRoom() exception:", ex);
        }
    }

    private remoteLeft(stanza: Element) {
        try {
            log.info(`${stanza.attrs.from} left ${stanza.attrs.to}`);
            const to = jid(stanza.attrs.to);
            const chatName = Util.prepJID(to);
            const user = this.members.getXmppMemberByRealJid(chatName, stanza.attrs.from);
            if (!user) {
                log.error(`User tried to leave room, but they aren't in the member list`);
                return false;
            }
            const lastDevice = this.members.removeXmppMember(chatName, stanza.attrs.from);
            const leaveStza = new StzaPresenceItem(
                user.anonymousJid.toString(),
                stanza.attrs.from,
                undefined,
                PresenceAffiliation.Member,
                PresenceRole.None,
                true,
                stanza.attrs.from,
            );
            leaveStza.presenceType = "unavailable";
            this.xmpp.xmppWriteToStream(leaveStza);
            this.upsertXMPPUser(stanza.attrs.from, user.matrixId);
            // If this is the last device for that member, reflect
            // that change to everyone.
            if (lastDevice) {
                leaveStza.self = false;
                this.reflectXMPPStanza(chatName, leaveStza);
                return true;
            }
            return false;
        } catch (ex) {
            log.error("remoteLeft() Exception:", ex);
        }
    }

    public stopGateway() {
        let kick = new StzaPresenceKick("", "");
        kick.reason = "Bridge is shutting down";
        kick.statusCodes.add(XMPPStatusCode.SelfPresence);
        kick.statusCodes.add(XMPPStatusCode.SelfKicked);
        kick.statusCodes.add(XMPPStatusCode.SelfKickedShutdown);
        for (const chatName of this.members.getMembershipRooms()) {
            for (const member of this.members.getXmppMembers(chatName)) {
                for (let device of member.devices) {
                    log.info(`Kicking ${device} from ${chatName} because we're shutting down`);
                    kick.from = member.anonymousJid.toString();
                    kick.to = device;
                    this.xmpp.xmppWriteToStream(kick);
                    this.members.removeXmppMember(chatName, member.realJid);
                }
            }
        }
    }
}

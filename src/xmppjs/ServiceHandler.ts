import { Element, x } from "@xmpp/xml";
import { XmppJsInstance } from "./XJSInstance";
import { jid, JID } from "@xmpp/jid";
import { Logging } from "matrix-appservice-bridge";
import request from "axios";
import { IGatewayRoom } from "../bifrost/Gateway";
import { IGatewayRoomQuery, IGatewayPublicRoomsQuery } from "../bifrost/Events";
import {
    encode, IStza, StzaIqDiscoInfo, StzaIqPing, StzaIqDiscoItems,
    StzaIqSearchFields, StzaIqError, StzaIqPingError, StzaIqMAMFields,
    StzaIqMAMFin, StzaMessageMAM
} from "./Stanzas";
import { IPublicRoomsResponse } from "../MatrixTypes";
import { IConfigBridge } from "../Config";
import { BridgeVersion, XMPPFeatures } from "./XMPPConstants";
import { Util } from "../Util";
import { IBifrostMAMRequest, MAMHandler } from "./MAM";

const log = Logging.get("ServiceHandler");

const MAX_AVATARS = 1024;

export class ServiceHandler {
    private avatarCache: Map<string, {data: Buffer, type: string}>;
    private discoInfo: StzaIqDiscoInfo;
    constructor(private xmpp: XmppJsInstance, private bridgeConfig: IConfigBridge) {
        this.avatarCache = new Map();
        this.discoInfo = new StzaIqDiscoInfo("", "", "");
        this.discoInfo.identity.add({category: "conference", type: "text", name: "Bifrost Matrix Gateway"});
        this.discoInfo.identity.add({category: "gateway", type: "matrix", name: "Bifrost Matrix Gateway"});
        this.discoInfo.feature.add(XMPPFeatures.DiscoInfo);
        this.discoInfo.feature.add(XMPPFeatures.DiscoItems);
        this.discoInfo.feature.add(XMPPFeatures.Muc);
        this.discoInfo.feature.add(XMPPFeatures.IqVersion);
        this.discoInfo.feature.add(XMPPFeatures.IqSearch);
    }

    public parseAliasFromJID(to: JID): string|null {
        const aliasRaw = /#(.+)#(.+)/g.exec(to.local);
        if (!aliasRaw || aliasRaw.length < 3) {
            return null;
        }
        return `#${aliasRaw[1]}:${aliasRaw[2]}`;
    }

    public createJIDFromAlias(alias: string): string|null {
        const aliasRaw = /#(.+):(.+)/g.exec(alias);
        if (!aliasRaw || aliasRaw.length < 3) {
            return null;
        }
        return `#${aliasRaw[1]}#${aliasRaw[2]}@${this.xmpp.xmppAddress.domain}`;
    }

    public async handleIq(stanza: Element, intent: any): Promise<void> {
        const id = stanza.getAttr("id");
        const from = stanza.getAttr("from");
        const to = stanza.getAttr("to");
        const type = stanza.getAttr("type");

        log.info("Handling iq request");

        if (stanza.getChildByAttr("xmlns", "jabber:iq:version")) {
            return this.handleVersionRequest(from, to, id);
        }

        // Only respond to this if it has no local part.
        const local = jid(to).local;
        if (stanza.getChildByAttr("xmlns", "http://jabber.org/protocol/disco#info") && !local) {
            return this.handleDiscoInfo(from, to, id);
        }

        if (stanza.getChildByAttr("xmlns", "vcard-temp") && type === "get") {
            return this.handleVcard(from, to, id, intent);
        }

        if (stanza.getChildByAttr("xmlns", "urn:xmpp:ping") && type === "get") {
            return this.handlePing(from, to, id);
        }

        if (this.xmpp.gateway) {
            const searchQuery = stanza.getChildByAttr("xmlns", "jabber:iq:search");
            if (stanza.getChildByAttr("xmlns", "http://jabber.org/protocol/disco#items") &&
                this.xmpp.xmppAddress.domain === jid(to).domain) {
                return this.handleDiscoItems(from, to, id, "", undefined);
            }

            if (searchQuery && !local) {
                // XXX: Typescript is a being a bit funny about Element, so doing an any here.
                return this.handleDiscoItems(from, to, id, stanza.attrs.type, searchQuery as any);
            }

            if (stanza.getChildByAttr("xmlns", "http://jabber.org/protocol/disco#info") && local) {
                return this.handleRoomDiscovery(to, from, id);
            }

            if (stanza.getChildByAttr("xmlns", XMPPFeatures.MessageArchiveManagement)) {
                const mamQuery = stanza.getChildByAttr("xmlns", XMPPFeatures.MessageArchiveManagement);
                return this.handleMAMQuery(to, from, id, stanza.attrs.type, mamQuery as any);
            }
        }

        return this.xmpp.xmppWriteToStream(x("iq", {
            type: "error",
            from: to,
            to: from,
            id,
        }, x("error", {
            type: "cancel",
            code: "503",
        },
        x("service-unavailable", {
            xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas",
        }),
        ),
        ));
    }

    private notFound(to: string, from: string, id: string, type: string, xmlns: string) {
        this.xmpp.xmppWriteToStream(
            x("iq", {
                type: "error",
                to,
                from,
                id,
            }, x(type, {
                xmlns,
            }),
            x("error", {
                type: "cancel",
                code: "404",
            }, x("item-not-found", {
                xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas",
            }),
            ),
            ));
    }

    private handleVersionRequest(to: string, from: string, id: string): Promise<void> {
        return this.xmpp.xmppWriteToStream(
            x("iq", {
                type: "result",
                to,
                from,
                id,
            }, x("query", {
                xmlns: "jabber:iq:version",
            },
            [
                x("name", undefined, "matrix-bifrost"),
                x("version", undefined, BridgeVersion),
            ],
            ),
            ));
    }

    private async handleDiscoInfo(to: string, from: string, id: string) {
        this.discoInfo.to = to;
        this.discoInfo.from = from;
        this.discoInfo.id = id;
        await this.xmpp.xmppSend(this.discoInfo);
    }

    private async handleDiscoItems(to: string, from: string, id: string, type: string,
        searchElement?: Element): Promise<void> {
        log.info("Got disco items request, looking up public rooms");
        let searchString = "";
        let homeserver: string|null = null;
        if (searchElement) {
            log.debug("Request was a search");
            if (type === "get") {
                log.debug("Responding with search fields");
                // Getting search fields.
                await this.xmpp.xmppSend(
                    new StzaIqSearchFields(
                        from,
                        to,
                        id,
                        "Please enter a search term to find Matrix rooms:",
                        {
                            Term: "",
                            Homeserver: this.bridgeConfig.domain,
                        },
                    ),
                );
                return;
            } else if (type === "set") {
                // Searching via a term.
                const form = searchElement.getChildByAttr("xmlns", "jabber:x:data");
                if (!form) {
                    log.warn(`Failed to search rooms: form is missing/invalid`);
                    await this.xmpp.xmppSend(new StzaIqError(from, to, id, "modify", 400, "bad-request", undefined,
                        "Request form is invalid"));
                    return;
                }

                const term = form.getChildByAttr("var", "term");
                if (term) {
                    searchString = term.getChildText("value");
                }
                const hServer = form.getChildByAttr("var", "homeserver");
                if (hServer) {
                    homeserver = hServer.getChildText("value");
                }
            } else {
                // Not sure what to do with this.
                return;
            }
        }

        const response = new StzaIqDiscoItems(
            from, to, id,
            searchElement ? "jabber:iq:search" : "http://jabber.org/protocol/disco#items",
        );
        let rooms: IPublicRoomsResponse;
        try {
            rooms = await new Promise((resolve, reject) => {
                this.xmpp.emit("gateway-publicrooms", {
                    searchString,
                    homeserver,
                    result: (err, res) => {
                        if (err) {
                            reject(err);
                        }
                        resolve(res);
                    },
                } as IGatewayPublicRoomsQuery);
            });
        } catch (ex) {
            log.warn(`Failed to search rooms: ${ex}`);
            // XXX: There isn't a very good way to explain why it failed,
            // so we use service unavailable.
            await this.xmpp.xmppSend(new StzaIqError(from, to, id, "cancel", 503, "service-unavailable", undefined,
                `Failure fetching public rooms from ${homeserver}`));
            return;
        }

        rooms.chunk.forEach((room) => {
            if (room.canonical_alias == null) {
                return;
            }
            if (room.canonical_alias !== room.canonical_alias.toLowerCase()) {
                return; // drop non lowercase aliases they'll break anyways
            }
            const j = this.createJIDFromAlias(room.canonical_alias);
            if (!j) {
                return;
            }
            response.addItem(j, room.name || room.canonical_alias);
        });
        await this.xmpp.xmppSend(response);
    }

    public queryRoom(roomAlias: string): Promise<any | IGatewayRoom> {
        try {
            return new Promise((resolve, reject) => {
                this.xmpp.emit("gateway-queryroom", {
                    roomAlias,
                    result: (err, res) => {
                        if (err) {
                            reject(err);
                        }
                        resolve(res);
                    },
                } as IGatewayRoomQuery);
            });
        } catch (ex) {
            log.error("Failed querying room:", ex);
        }
    }

    private async handleRoomDiscovery(toStr: string, from: string, id: string) {
        try {
            const to = jid(toStr);
            const alias = this.parseAliasFromJID(to);
            if (!alias) {
                throw Error("Not a valid alias");
            }
            log.debug(`Running room discovery for ${toStr}`);
            let roomData = await this.queryRoom(alias) as any;
            log.info(`Response for alias request ${toStr} (${alias}) -> ${roomData.roomId}`);
            const discoInfo = new StzaIqDiscoInfo(toStr, from, id);
            discoInfo.feature.add(XMPPFeatures.DiscoInfo);
            discoInfo.feature.add(XMPPFeatures.Muc);
            discoInfo.feature.add(XMPPFeatures.MessageCorrection);
            discoInfo.feature.add(XMPPFeatures.MessageModeration);
            discoInfo.feature.add(XMPPFeatures.MessageRetraction);
            discoInfo.feature.add(XMPPFeatures.MessageArchiveManagement);
            discoInfo.feature.add(XMPPFeatures.StableStanzaIDs);
            discoInfo.feature.add(XMPPFeatures.XHTMLIM);
            discoInfo.feature.add(XMPPFeatures.vCard);
            discoInfo.identity.add({
                category: "conference",
                name: alias,
                type: "text",
            });
            discoInfo.identity.add({
                category: "gateway",
                name: alias,
                type: "matrix",
            });
            discoInfo.roominfo.add({
                label: "Description",
                var: "muc#roominfo_description",
                type: "text-single",
                value: encode(roomData.roomDesc),
            });
            discoInfo.roominfo.add({
                label: "Number of occupants",
                var: "muc#roominfo_occupants",
                type: "text-single",
                value: roomData.roomOccupants.toString(),
            });
            await this.xmpp.xmppSend(discoInfo);
        } catch (ex) {
            await this.xmpp.xmppSend(new StzaIqError(toStr, from, id, "cancel", 404, "item-not-found", undefined, "Room could not be found"));
        }
    }

    private async getThumbnailBuffer(avatarUrl: string, intent: any): Promise<{ data: Buffer, type: string } | undefined> {
        try {
            let avatar = this.avatarCache.get(avatarUrl);
            if (avatar) {
                return avatar;
            }
            const thumbUrl = intent.getClient().mxcUrlToHttp(
                avatarUrl, 256, 256, "scale", false,
            );
            if (!thumbUrl) {
                return undefined;
            }

            const file = await request.get(thumbUrl, {
                responseType: "arraybuffer",
            });
            avatar = {
                data: Buffer.from(file.data),
                type: file.headers["content-type"],
            };
            this.avatarCache.set(avatarUrl, avatar);
            if (this.avatarCache.size > MAX_AVATARS) {
                this.avatarCache.delete(this.avatarCache.keys()[0]);
            }
            return avatar;
        } catch (ex) {
            log.error("Error Processing Thumbnail Buffer:", ex);
        }
    }

    private async handleVcard(from: string, to: string, id: string, intent: any) {
        try {
            // Fetch mxid.
            const toJid = jid(to);
            let mxId: string;
            let profile: { displayname?: string, avatar_url?: string };
            // check if we're querying an account or a gateway room
            if (to.match(/^#/) && !toJid.resource) { // it's a gateway
                try {
                    const alias = this.parseAliasFromJID(toJid);
                    if (!alias) {
                        log.warn(`${Util.prepJID(toJid)} tried to query an invalid alias`);
                        this.notFound(from, to, id, "vCard", "vcard-temp");
                    }
                    const query = await this.queryRoom(alias) as any;
                    mxId = query.roomId;
                    profile = { avatar_url: query.roomAvatar };
                } catch (ex) {
                    log.warn(`Failed to query room vCard: ${ex}`);
                    this.notFound(from, to, id, "vCard", "vcard-temp");
                }
            } else {
                const account = this.xmpp.getAccountForJid(toJid);
                if (!account) {
                    log.warn("Account fetch failed for", to);
                    this.notFound(from, to, id, "vCard", "vcard-temp");
                    return;
                }
                mxId = account.mxId;
                try {
                    // TODO: Move this to a gateway-profilelookup or something.
                    if (mxId.match(/^@/)) {
                        profile = await intent.getProfileInfo(mxId, null);
                    } else {
                        throw Error(`Account ${mxId} is still in an undefined state`);
                    }
                } catch (ex) {
                    log.warn("Profile fetch failed for ", mxId, ex);
                    this.notFound(from, to, id, "vCard", "vcard-temp");
                    return;
                }
            }

            const vCard: Element[] = [
                x("URL", undefined, `https://matrix.to/#/${mxId}`),
            ];

            if (profile.displayname) {
                vCard.push(x("FN", undefined, profile.displayname));
                vCard.push(x("NICKNAME", undefined, profile.displayname));
            }

            if (profile.avatar_url) {
                try {
                    const res = await this.getThumbnailBuffer(profile.avatar_url, intent);
                    if (res) {
                        const b64 = res.data.toString("base64");
                        vCard.push(
                            x("PHOTO", undefined, [
                                x("BINVAL", undefined, b64),
                                x("TYPE", undefined, res.type),
                            ]),
                        );
                    }
                } catch (ex) {
                    log.warn("Could not fetch avatar for ", mxId, ex);
                }
            }

            this.xmpp.xmppWriteToStream(
                x("iq", {
                    type: "result",
                    to: from,
                    from: to,
                    id,
                }, x("vCard", {
                    xmlns: "vcard-temp",
                },
                    vCard,
                ),
                ));
        } catch (ex) {
            log.error("Error Handling vCard IQ:", ex);
        }
    }

    private async handlePing(from: string, to: string, id: string) {
        try {
            const fromJid = jid(from);
            const toJid = jid(to);
            log.debug(`Got ping from=${from} to=${to} id=${id}`);
            // https://xmpp.org/extensions/xep-0199.html
            if (to === this.xmpp.xmppAddress.domain) {
                // Server-To-Server pings
                if (jid(from).domain === from) {
                    await this.xmpp.xmppSend(new StzaIqPing(to, from, id, "result"));
                    log.debug(`S2S ping result sent to ${from}`);
                    return;
                }
                // If the 'from' part is not a domain, this is not a S2S ping.
            }

            // https://xmpp.org/extensions/xep-0410.html
            if (toJid.local && toJid.resource) {
                // Self ping
                if (!this.xmpp.gateway) {
                    // No gateways configured, not pinging.
                    return;
                }
                const chatName = Util.prepJID(toJid);
                const gatewayResult = !!this.xmpp.gateway.isJIDInMuc(chatName, fromJid);
                const plumbedResult = !!this.xmpp.getAccountForJid(new JID(toJid.local, toJid.domain));
                if (gatewayResult || plumbedResult) {
                    await this.xmpp.xmppSend(new StzaIqPing(to, from, id, "result"));
                } else {
                    await this.xmpp.xmppSend(new StzaIqPingError(to, from, id, "not-acceptable", chatName));
                }
                log.debug(`Self ping result sent to ${from}`);
                return;
            }

            // All other pings are invalid in this context and will be ignored.
            await this.xmpp.xmppSend(new StzaIqPingError(to, from, id, "service-unavailable"));
        } catch (ex) {
            log.error("Failed Processing Ping IQ:", ex);
        }
    }

    private async handleMAMQuery(to: string, from: string, id: string, type: string, query: Element) {
        // https://xmpp.org/extensions/xep-0313.html
        try {
            const alias = this.parseAliasFromJID(jid(to));
            if (!alias) {
                throw Error("Not a valid alias");
            }
            let roomData = await this.queryRoom(alias) as any;
            log.info(`Response for alias request ${to} (${alias}) -> ${roomData.roomId}`);

            if (type === "get") {
                // return supported fields
                const response = new StzaIqMAMFields(to, from, id, this.xmpp.mamHandler.supportedFields());
                await this.xmpp.xmppSend(response);
            } else if (type === "set") {
                if (roomData.allowHistory !== "shared" && roomData.allowHistory !== "world_readable") {
                    await this.xmpp.xmppSend(new StzaIqError(to, from, id, "cancel", 405, "not-allowed", undefined,
                        `Room history visibility needs to be set to either shared or world_readable it currently is: ${roomData.allowHistory}`));
                    return;
                }
                const data = query.getChildByAttr("xmlns", "jabber:x:data");
                const queryId = query.getAttr("queryid");
                const qStart = data?.getChildByAttr("var", "start")?.getChildText("value");
                const qEnd = data?.getChildByAttr("var", "end")?.getChildText("value");
                const qWith = data?.getChildByAttr("var", "with")?.getChildText("value");
                let request = {
                    gatewayAlias: alias,
                    gatewayJID: to,
                    roomId: roomData.roomId,
                } as IBifrostMAMRequest;
                if (qStart) {
                    request.start = new Date(qStart);
                }
                if (qEnd) {
                    request.end = new Date(qEnd);
                }
                if (qWith) {
                    request.with = qWith;
                }
                const set = query.getChildByAttr("xmlns", "http://jabber.org/protocol/rsm");
                if (set) {
                    let rsm: { before: true|string|undefined, after: true|string|undefined, max: number|undefined } = {
                        before: set.getChildText("before") || (set.getChild("before") ? true : undefined),
                        after: set.getChildText("after") || (set.getChild("after") ? true : undefined),
                        max: set.getChildText("max") ? Number(set.getChildText("max")) : undefined,
                    };
                    request.rsm = rsm;
                }
                const mamQuery = await this.xmpp.mamHandler.getEntries(request);
                if (mamQuery.not_found) {
                    log.error("MAM query " + queryId || id + " didn't return any result (failed RSM)");
                    await this.xmpp.xmppSend(new StzaIqError(to, from, id, "cancel", 404, "item-not-found"));
                    return;
                }
                if (mamQuery.results.length !== 0) {
                    let stanzas: IStza[] = [];
                    for (const entry of mamQuery.results) {
                        let mamClone = Object.assign({}, entry);
                        let forwarded = new StzaMessageMAM(to, from, queryId, mamClone);
                        stanzas.push(forwarded);
                    }
                    await this.xmpp.xmppSendBulk(stanzas);
                }
                let response = new StzaIqMAMFin(to, from, id,
                    mamQuery.first_id, mamQuery.last_id, mamQuery.count, mamQuery.index, mamQuery.complete);
                await this.xmpp.xmppSend(response);
            }
        } catch (ex) {
            log.error("Encountered error while processing MAM request: ", ex);
            await this.xmpp.xmppSend(new StzaIqError(to, from, id, "cancel", 500, "internal-server-error", undefined,
                "Encountered an internal error while processing your request"));
        }
    }
}

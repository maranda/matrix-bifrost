/* eslint-disable max-classes-per-file */
import { v4 as uuid } from "uuid";
import * as he from "html-entities";
import { IBasicProtocolMessage } from "../MessageFormatter";
import { XMPPFeatures, XMPPStatusCode } from "./XMPPConstants";
import { Util } from "../Util";
import { IBifrostMAMEntry } from "./MAM";
import { XHTMLIM } from "./XHTMLIM";
import { jid, JID } from "@xmpp/jid";

const REGEXP_AS_PREFIX = /@(_[a-zA-Z0-9]+_).*/;
const REGEXP_HTML_TRAIL = /(<a href=['"]#['"]>)(@[a-zA-Z0-9_.=-]+:[a-zA-Z0-9.-]+)(<\/a>)/;
const REGEXP_TEXT_TRAIL = /^> <(@[a-zA-Z0-9_.=-]+:[a-zA-Z0-9.-]+)> /;

export function encode(text) {
    return he.encode(text, { level: "xml", mode: "nonAscii"});
}

export interface IStza {
    type: string;
    xml: string;
}

export enum PresenceRole {
    None = "none",
    Visitor = "visitor",
    Participant = "participant",
    Moderator = "moderator",
}

export enum PresenceAffiliation {
    None = "none",
    Outcast = "outcast",
    Member = "member",
    Admin = "admin",
    Owner = "owner",
}

export abstract class StzaBase implements IStza {
    private hFrom: string = "";
    private hTo: string = "";
    private hId?: string = "";
    constructor(from: string, to: string, id?: string) {
        this.from = from;
        this.to = to;
        this.id = id;
    }

    get type(): string { throw Error('type not defined') }

    get xml(): string { throw Error('xml not defined') }

    get from() { return this.hFrom; }

    set from(val: string) {
        this.hFrom = encode(val);
    }

    get to() { return this.hTo; }

    set to(val: string) {
        this.hTo = encode(val);
    }

    get id(): string|undefined { return this.hId || undefined; }

    set id(val: string|undefined) {
        if (!val) { return; }
        this.hId = encode(val);
    }

}

export class StzaPresence extends StzaBase {
    protected includeXContent: boolean = true;
    constructor(
        from: string,
        to: string,
        id?: string,
        public presenceType?: string,
        public avatarHash?: string,
    ) {
        super(from, to, id);
    }

    get xContent(): string { return ""; }

    get xProtocol(): string { return "muc"; }

    get presenceContent(): string { return ""; }

    get type(): string {
        return "presence";
    }

    get xml(): string {
        const type = this.presenceType ? ` type='${this.presenceType}'` : "";
        const id = this.id ? ` id="${this.id}"` : "";
        let content = "";
        if (this.includeXContent) {
            content = this.xContent ? `<x xmlns='http://jabber.org/protocol/${this.xProtocol}'>${this.xContent}</x>` :
                "<x xmlns='http://jabber.org/protocol/muc'/>";
        }
        return `<presence from="${this.from}" to="${this.to}"${id}${type}>${content}${this.presenceContent}</presence>`;
    }
}

export class StzaPresenceItem extends StzaPresence {
    public statusCodes: Set<XMPPStatusCode>;
    public actor?: string;
    public reason?: string;
    constructor(
        from: string,
        to: string,
        id?: string,
        public affiliation: PresenceAffiliation = PresenceAffiliation.Member,
        public role: PresenceRole = PresenceRole.Participant,
        self: boolean = false,
        public jid: string = "",
        itemType: string = "",
        public avatarHash?: string,
        public newNick?: string,
    ) {
        super(from, to, id, itemType);
        this.statusCodes = new Set();
        this.self = self;
    }

    set self(isSelf: boolean) {
        this.statusCodes[isSelf ? "add" : "delete"](XMPPStatusCode.SelfPresence);
    }

    get xProtocol(): string { return "muc#user"; }

    public get xContent() {
        const jid = this.jid ? ` jid='${this.jid}'` : "";
        const nick = this.newNick ? ` nick='${this.newNick}'` : "";
        let xml = [...this.statusCodes].map((s) => `<status code='${s}'/>`).join("");
        xml += `<item affiliation='${this.affiliation}'${jid}${nick} role='${this.role}'`;
        if (!this.actor && !this.reason) {
            return xml + "/>";
        }
        xml += ">";
        if (this.actor) {
            xml += `<actor nick='${encode(this.actor)}'/>`
        }
        if (this.reason) {
            xml += `<reason>${encode(this.reason)}</reason>`
        }
        xml += "</item>";
        return xml;
    }

    public get presenceContent() {
        if (this.avatarHash) {
            return `<x xmlns='vcard-temp:x:update'><photo>${this.avatarHash}</photo></x>`;
        }
        return "";
    }
}

export class StzaPresenceError extends StzaPresence {
    constructor(
        from: string,
        to: string,
        id: string,
        public by: string,
        public errType: string,
        public innerError: string,
        public text?: string,

    ) {
        super(from, to, id, "error");
    }

    public get presenceContent() {
        return `<error type='${this.errType}' by='${this.by}'><${this.innerError}`
             + " xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/>"
             + (this.text ? `<text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas">${encode(this.text)}</text>` : "")
             + "</error>";
    }
}

export class StzaPresenceJoin extends StzaPresence {
    constructor(
        from: string,
        to: string,
        id?: string,
        public presenceType?: string,
        public avatarHash?: string,
    ) {
        super(from, to, id);
    }

    public get xContent() {
        // No history.
        // TODO: I'm sure we want to be able to configure this.
        return `<history maxchars='0'/>`;
    }

    public get presenceContent() {
        if (this.avatarHash) {
            return `<x xmlns='vcard-temp:x:update'><photo>${this.avatarHash}</photo></x>`;
        }
        return "";
    }
}

export class StzaPresencePart extends StzaPresence {
    constructor(
        from: string,
        to: string,
    ) {
        super(from, to, undefined, "unavailable");
        this.includeXContent = false;
        this.id = undefined;
    }
}

export class StzaPresencePhoto extends StzaPresence {
    constructor(
        from: string,
        to: string,
        id?: string,
        public presenceType?: string,
        public avatarHash?: string,
    ) {
        super(from, to, id);
        this.includeXContent = false;
    }

    public get presenceContent() {
        if (this.avatarHash) {
            return `<x xmlns='vcard-temp:x:update'><photo>${this.avatarHash}</photo></x>`;
        }
        return `<x xmlns='vcard-temp:x:update'><photo/></x>`;
    }
}

export class StzaPresenceKick extends StzaPresenceItem {
    constructor(
        from: string,
        to: string,
        reason?: string,
        actorNick?: string,
        self: boolean = false,
    ) {
        super(from, to, undefined, PresenceAffiliation.None, PresenceRole.None, self, undefined, "unavailable");
        this.actor = actorNick;
        this.reason = reason;
        this.statusCodes.add(XMPPStatusCode.SelfKicked);
    }
}
export class StzaMessage extends StzaBase {
    public html: string = "";
    public body: string = "";
    public markable: boolean = false;
    public attachments: string[] = [];
    public addNS?: string;
    public replacesId?: string;
    public redactsId?: string;
    public originId: string;
    public stanzaId: string;
    public moderation?: boolean;
    public moderationReason?: string;
    constructor(
        from: string,
        to: string,
        idOrMsg?: string|IBasicProtocolMessage,
        public messageType?: string,
    ) {
        super(from, to, undefined);
        if (idOrMsg && (idOrMsg.hasOwnProperty("body") || idOrMsg.hasOwnProperty("redacted"))) {
            idOrMsg = idOrMsg as IBasicProtocolMessage;
            this.body = idOrMsg.body;
            if (idOrMsg.formatted) {
                const html = idOrMsg.formatted.find((f) => f.type === "html");
                this.html = html ? html.body : "";
            }
            if (idOrMsg.opts) {
                this.attachments = (idOrMsg.opts.attachments || []).map((a) => a.uri);
            }
            this.id = idOrMsg.id;
            if (idOrMsg.original_message) {
                this.replacesId = idOrMsg.original_message;
            }
            if (idOrMsg.redacted?.redact_id) {
                this.redactsId = idOrMsg.redacted.redact_id;
                this.moderation = idOrMsg.redacted.moderation;
                this.moderationReason = idOrMsg.redacted.reason;
            }
            this.originId = idOrMsg.origin_id;
            this.stanzaId = idOrMsg.stanza_id;
        } else if (typeof(idOrMsg) === "string") {
            this.id = idOrMsg as string;
        }
    }

    get type(): string {
        return "message";
    }

    get xml(): string {
        const xmlns = this.addNS ? `xmlns='${this.addNS}' ` : "";
        const type = this.messageType ? ` type='${this.messageType}'` : "";
        const attachments = this.attachments.map((a) =>
            `<x xmlns='jabber:x:oob'><url>${encode(a)}</url></x>`,
        );
        if (this.attachments.length === 1) {
            // For reasons unclear to me, XMPP reccomend we make the body == attachment url to make them show up inline.
            this.body = this.attachments[0];
        }
        // Remove mxID trailer in replies if it's too long
        const trailMatch = this.body?.match(REGEXP_TEXT_TRAIL);
        if (trailMatch) {
            const hasPrefix = trailMatch[1].match(REGEXP_AS_PREFIX);
            const prefix = hasPrefix ? hasPrefix[1] : null;
            const nickname = prefix ? Util.getResourceFromMxid(trailMatch[1], prefix) : null;
            if (nickname) {
                this.body = this.body.replace(REGEXP_TEXT_TRAIL, `> <${nickname}> `);
            } else if (trailMatch[1].length > 25) {
                this.body = this.body.replace(REGEXP_TEXT_TRAIL, "> ");
            }
        }
        // Also fix the trailer into XHTML-IM if present
        if (this.html !== "") {
            const htrailMatch = this.html?.match(REGEXP_HTML_TRAIL);
            if (htrailMatch) {
                const hasPrefix = htrailMatch[2].match(REGEXP_AS_PREFIX);
                const prefix = hasPrefix ? hasPrefix[1] : null;
                const nickname = prefix ? Util.getResourceFromMxid(htrailMatch[2], prefix) : null;
                if (nickname) {
                    this.html = this.html.replace(REGEXP_HTML_TRAIL, `<em>${nickname}</em>`);
                } else if (htrailMatch[3].length > 25) {
                    this.html = this.html.replace(REGEXP_HTML_TRAIL, "<em>User</em>");
                }
            }
        }
        // XEP-0333
        const markable = this.markable ? "<markable xmlns='urn:xmpp:chat-markers:0'/>" : "";
        // XEP-0308
        const replaces = this.replacesId ? `<replace id='${this.replacesId}' xmlns='urn:xmpp:message-correct:0'/>` : "";
        // XEP-424 / XEP-425
        let redacts: string = "";
        if (this.moderation) {
            redacts = `<apply-to id='${this.redactsId}' xmlns='urn:xmpp:fasten:0'>`
                + `<moderated xmlns='urn:xmpp:message-moderate:0' by='${jid(this.from)?.bare()?.toString()}'>`
                + `<retract xmlns='urn:xmpp:message-retract:0'/>${this.moderationReason ? `<reason>${this.moderationReason}</reason>` : ""}`
                + `</moderated></apply-to>`;
        } else if (this.redactsId) {
            redacts = `<apply-to id='${this.redactsId}' xmlns='urn:xmpp:fasten:0'><retract xmlns='urn:xmpp:message-retract:0'/></apply-to>`;
        }
        // XEP-0359
        const originId = this.originId ? `<origin-id id='${this.originId}' xmlns='urn:xmpp:sid:0'/>` : "";
        let stanzaId: string = "";
        if (this.stanzaId) {
            stanzaId = `<stanza-id id='${this.stanzaId}' xmlns='urn:xmpp:sid:0' by='${jid(this.from)?.bare()?.toString()}'/>`;
        }
        const bodyEl = this.body ? `<body>${encode(this.body)}</body>` : "";
        const toAttr = this.to ? `to='${this.to}' ` : "";
        return `<message ${xmlns}from='${this.from}' ${toAttr}id='${this.id}'${type}>`
            + `${this.html}${bodyEl}${attachments}${markable}${replaces}${redacts}${originId}${stanzaId}</message>`;
    }
}

export class StzaMessageSubject extends StzaBase {
    constructor(
        from: string,
        to: string,
        id?: string,
        public subject: string = "",
    ) {
        super(from, to, id);
    }

    get content(): string { return ""; }

    get type(): string {
        return "message";
    }

    get xml(): string {
        return `<message from="${this.from}" to="${this.to}" id="${this.id}" type='groupchat'>`
             + `<subject>${encode(this.subject)}</subject></message>`;
    }
}

export class StzaMessageMAM extends StzaBase {
    private delay: string;
    private entryStza: StzaMessage;
    private entryId: string;
    private queryId: string;
    constructor(
        from: string,
        to: string,
        queryId: string,
        entry: IBifrostMAMEntry,
    ) {
        super(from, to);
        this.delay = new Date(entry.timestamp).toISOString();
        if (entry.payload.formatted?.length) {
            entry.payload.formatted.forEach(
                (f) => { if (f.type === "html") { f.body = XHTMLIM.HTMLToXHTML(f.body); } },
            );
        }
        this.entryStza = new StzaMessage(entry.from, undefined, entry.payload, "groupchat");
        this.entryId = entry.stanzaId || entry.payload?.id;
        this.entryStza.addNS = "jabber:client"; // add NS to forwarded stanza
        this.entryStza.originId = entry.originId;
        this.entryStza.id = entry.originId ? entry.originId : this.entryStza.id;
        this.queryId = queryId ? ` queryid='${queryId}'` : "";
    }

    get type(): string {
        return "message";
    }

    get xml(): string {
        return `<message from='${this.from}' to='${this.to}' id='${uuid()}'>`
            + `<result xmlns='urn:xmpp:mam:2'${this.queryId} id='${this.entryId}'><forwarded xmlns='urn:xmpp:forward:0'>`
            + `<delay xmlns='urn:xmpp:delay' stamp='${this.delay}'/>${this.entryStza.xml}`
            + `</forwarded></result></message>`;
    }
}

export class StzaIqPing extends StzaBase {
    protected extraContent: string = "";
    constructor(
        from: string,
        to: string,
        id: string,
        public responseType: string,
    ) {
        super(from, to, id || uuid());
    }

    get type(): string {
        return "iq";
    }

    get xml(): string {
        return `<iq from='${this.from}' to='${this.to}' id='${this.id}' type='${this.responseType}'>`
               + `<ping xmlns='urn:xmpp:ping'/>${this.extraContent}</iq>`;
    }
}

export class StzaIqPingError extends StzaIqPing {
    constructor(
        from: string,
        to: string,
        id: string,
        private eType: "service-unavailable"|"not-acceptable",
        private by?: string,
    ) {
        super(from, to, id, "error");
        this.extraContent = `<error type='cancel'${this.by ? ` by='${this.by}'` : ""}>`
        + `<${this.eType} xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error>`;
    }
}

export abstract class StzaIqQuery extends StzaBase {
    constructor(
        from: string,
        to: string,
        id: string,
        protected iqType = "result",
        protected queryType = "",
    ) {
        super(from, to, id);
    }

    get type(): string {
        return "iq";
    }

    get queryContent(): string { return ""; }

    get xml(): string {
        return `<iq from='${this.from}' to='${this.to}' id='${this.id}' type='${this.iqType}'>`
         + `<query xmlns='${this.queryType}'>${this.queryContent}</query></iq>`;
    }
}

export class StzaIqDiscoItems extends StzaIqQuery {
    private items: {jid: string, name: string}[];
    constructor(
        from: string,
        to: string,
        id: string,
        queryType: string,
    ) {
        super(from, to, id, "result", queryType);
        this.items = [];
    }

    get queryContent(): string {
        if (this.queryType === "jabber:iq:search") {
            let data = `<x xmlns='jabber:x:data' type ='result'>`
                + `<field type='hidden' var='FORM_TYPE'><value>jabber:iq:search</value></field>`
                + `<reported><field var='address' label='MUC Address' type='text-single'/><field var='name' label='Name' type='text-single'/></reported>`;
            this.items.map((item) =>
                data += `<item jid='${encode(item.jid)}'><field var='address' label='MUC Address' type='text-single'><value>${encode(item.jid)}</value></field>`
                + `<field var='name' label='Name' type='text-single'><value>${encode(item.name)}</value></field></item>`
            );
            data += `</x>`;
            return data;
        } else {
            const items = this.items.map((item) =>
                `<item jid='${encode(item.jid)}' name='${encode(item.name)}'/>`,
            ).join("");
            return items;
        }
    }

    public addItem(jid: string, name: string) {
        this.items.push({jid, name});
    }
}

export class StzaIqDiscoInfo extends StzaIqQuery {
    public identity: Set<{ category: string, type: string, name: string }>;
    public feature: Set<XMPPFeatures>;
    public roominfo: Set<{ label: string, var: string, type: string, value: string }>;

    constructor(
        from: string,
        to: string,
        id: string,
        iqType = "result") {
        super(from, to, id, iqType, "http://jabber.org/protocol/disco#info");
        this.identity = new Set();
        this.feature = new Set();
        this.roominfo = new Set();
    }

    get queryContent(): string {
        let identity = "";
        let feature = "";
        let roominfo = "<x type='result' xmlns='jabber:x:data'><field var='FORM_TYPE' type='hidden'><value>http://jabber.org/protocol/muc#roominfo</value></field>"
        this.identity.forEach((ident) => {
            identity += `<identity category='${ident.category}' type='${ident.type}' name='${ident.name}'/>`;
        });
        this.feature.forEach((feat) => {
            feature += `<feature var='${feat}'/>`;
        });
        this.roominfo.forEach((field) => {
            roominfo += `<field label='${field.label}' var='${field.var}' type='${field.type}'><value>${field.value}</value></field>`;
        });
        roominfo = roominfo += `</x>`;

        if (this.roominfo.size !== 0) {
            return identity + feature + roominfo;
        }
        return identity + feature;
    }

}

export class StzaIqMAMFields extends StzaIqQuery {
    private readonly mamFields: Map<string, string>;
    constructor(
        from: string,
        to: string,
        id: string,
        fields: Map<string, string>,
    ) {
        super(from, to, id, "result", "urn:xmpp:mam:2");
        this.mamFields = fields;
    }

    get queryContent(): string {
        let content = "<x type='form' xmlns='jabber:x:data' >"
            + "<field var='FORM_TYPE' type='hidden'><value>urn:xmpp:mam:2</value></field>";
        this.mamFields.forEach((fieldType, fieldName) => {
            content = content + `<field var='${fieldName}' type='${fieldType}'/>`;
        });
        content + "</x>";
        return content;
    }
}

export class StzaIqMAMFin extends StzaBase {
    private first: string;
    private last: string;
    private count: number;
    private index: number;
    private complete: boolean;
    constructor(
        from: string,
        to: string,
        id: string,
        first: string,
        last: string,
        count: number,
        index: number,
        complete?: boolean,
    ) {
        super(from, to, id);
        this.first = first;
        this.last = last;
        this.count = count;
        this.index = index;
        this.complete = complete;
    }

    get type(): string {
        return "iq";
    }

    get xml(): string {
        let firstEl = this.first ? `<first index='${this.index}'>${this.first}</first>` : "";
        let lastEl = this.last ? `<last>${this.last}</last>` : ""
        return `<iq from='${this.from}' to='${this.to}' id='${this.id}' type='result'>`
            + `<fin xmlns='urn:xmpp:mam:2' stable='false'${this.complete ? " complete='true'" : ""}>`
            + `<set xmlns='http://jabber.org/protocol/rsm'>`
            + firstEl + lastEl
            + `<count>${this.count}</count >`
            + `</set>`
            + `</fin></iq>`;
    }
}

export class StzaIqSearchFields extends StzaBase {
    constructor(
        from: string,
        to: string,
        id: string,
        public instructions: string,
        public fields: {[key: string]: string},
    ) {
        super(from, to, id);
    }

    get type(): string {
        return "iq";
    }

    get queryContent(): string { return ""; }

    get xml(): string {
        const fields = Object.keys(this.fields).map((field) => `<field type='text-single' label='${field}' var='${field.toLowerCase()}'><value>${this.fields[field]}</value></field>`).join("");
        return `<iq from='${this.from}' to='${this.to}' id='${this.id}' type='result' xml:lang='en'>`
        + `<query xmlns='jabber:iq:search'><instructions>${encode(this.instructions)}</instructions>`
        + `<x xmlns='jabber:x:data' type='form'><field type='hidden' var='FORM_TYPE'><value>jabber:iq:search</value></field>`
        + `${fields}</x></query></iq>`;
    }
}

export class StzaIqError extends StzaBase {
    constructor(
        from: string,
        to: string,
        id: string,
        private errorType: string,
        private errorCode: number|null,
        private innerError: string,
        private by?: string,
        private text?: string,
    ) {
        super(from, to, id);
    }

    get type(): string {
        return "iq";
    }

    get xml(): string {
        let errorParams = "";
        if (this.errorCode) {
            errorParams += ` code='${this.errorCode}'`;
        }
        if (this.by) {
            errorParams += ` by='${this.by}'`;
        }
        return `<iq from='${this.from}' to='${this.to}' id='${this.id}' type='error' xml:lang='en'>`
        + `<error type='${this.errorType}'${errorParams}><${this.innerError} ` +
          "xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/>" +
          (this.text ? `<text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas">${encode(this.text)}</text>` : "") +
          "</error></iq>";
    }
}

export class StzaIqVcardRequest extends StzaBase {

    constructor(from: string, to: string, id) {
        super(from, to, id);
    }

    get type(): string {
        return "iq";
    }

    get xml(): string {
        return `<iq from='${this.from}' to='${this.to}' id='${this.id}' type='get'>` +
            "<vCard xmlns='vcard-temp'/>" +
        "</iq>";
    }
}

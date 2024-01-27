export enum XMPPStatusCode {
    RoomNonAnonymous = "100",
    SelfPresence = "110",
    RoomLoggingEnabled = "170",
    RoomLoggingDisabled = "171",
    RoomNowNonAnonymous = "172",
    SelfBanned = "301",
    SelfChangingNick = "303",
    SelfKicked = "307",
    SelfKickedShutdown = "332",
    SelfKickedTechnical = "333",
}

export enum XMPPFeatures {
    DiscoInfo = "http://jabber.org/protocol/disco#info",
    DiscoItems = "http://jabber.org/protocol/disco#items",
    Muc = "http://jabber.org/protocol/muc",
    IqVersion = "jabber:iq:version",
    IqSearch = "jabber:iq:search",
    MessageArchiveManagement = "urn:xmpp:mam:2",
    MessageCorrection = "urn:xmpp:message-correct:0",
    MessageModeration = "urn:xmpp:message-moderate:0",
    MessageRetraction = "urn:xmpp:message-retract:0",
    StableStanzaIDs = "urn:xmpp:sid:0",
    XHTMLIM = "http://jabber.org/protocol/xhtml-im",
    vCard = "vcard-temp",
}

export const BridgeVersion = "0.5.1.arianet.6"
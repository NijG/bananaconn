// Passwords, keys and tokens in text: masked before anything goes to a cloud
// AI or into a saved conversation (ai/core.ts), and the reason a command or a
// copied text is not kept in the history (cmdLine.ts, clipboard.ts). One set of
// rules, so what the AI would never see is never stored either.
//
// A run of any characters inside a rule is bounded ({0,300}): a long pasted
// line is read in linear time, not in its length squared.

export const SECRET = "«SECRET»";

/** [pattern: group 1 is kept, group 2 is the secret]. */
export const SECRET_RULES: RegExp[] = [
  // key = value, key: value (password=, api_key:, TOKEN=, "secret": "…")
  /((?<![a-z])(?:pass(?:word|wd|phrase)?|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)\w*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
  // --password x, --token=x, also first on a line (a "(" starts an expression,
  // e.g. a ConvertTo-SecureString call, masked below)
  /((?:^|\s)--?(?:pass(?:word|wd)?|token|secret|api[_-]?key)(?:=|\s+))(?!\()(\S+)/gim,
  // PowerShell: ConvertTo-SecureString 'plain' -AsPlainText (also inside -Password (…))
  /(ConvertTo-SecureString\s+(?:-String\s+)?)("[^"\n]*"|'[^'\n]*'|[^\s)]+)/gi,
  // net user <name> <password> /add — not a switch (/add, -something)
  /(\bnet\s+user\s+[^\s/]+\s+)(?![/-])(\S+)/gi,
  // mysql -pSECRET
  /(\bmysql\w*\b[^\n]{0,300}?\s-p)(\S+)/g,
  // Tools that take the password as a plain argument (an option right after
  // "-p" means none was given: "mongo -p --host db" prompts for it).
  /(\blogin\b[^\n]{0,300}?\s-p\s*)(?!-)(\S+)/gi, // docker / podman / az login -p
  /(\bsmbclient\b[^\n]{0,300}?\s(?:-U|--user(?:name)?=?)\s*[^\s%]+%)(\S+)/gi, // -U user%pass
  /(\bnmcli\b[^\n]{0,300}?\b(?:password|psk)\s+)(\S+)/gi,
  /(\bredis-cli\b[^\n]{0,300}?\s-a\s*)(?!-)(\S+)/gi,
  /(\bmongo(?:sh)?\b[^\n]{0,300}?\s-p\s*)(?!-)(\S+)/gi,
  /(\bipmitool\b[^\n]{0,300}?\s-P\s*)(\S+)/g, // -P password (-p is the port)
  /(\bsshpass\b[^\n]{0,300}?\s-p\s*)(\S+)/g,
  // A letter precedes "password" here, which the first rule's guard skips.
  /(\bpgpassword\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
  /(\bsnmp\w*\b[^\n]{0,300}?\s-c\s*)(\S+)/g, // snmpwalk -c community
  // curl -u user:pass
  /(\s(?:-u|--user)\s*[^\s:]+:)(\S+)/g,
  // scheme://user:pass@host, also with no user ("ssh://:pass@host")
  /(:\/\/[^\s/:@]*:)([^\s/@]+)(?=@)/g,
  // Authorization: Bearer x
  /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/g,
  // Cisco / Aruba / Huawei / Juniper / FortiGate configuration secrets
  /^(\s*(?:enable\s+)?(?:secret|password)\s+(?:\d+\s+)?)(\S+)/gim,
  /(\busername\s+\S+[^\n]{0,300}?\s(?:secret|password)\s+(?:\d+\s+)?)(\S+)/gi,
  /(\bsnmp-server\s+community\s+)(\S+)/gi,
  // Within one line from here on ([ \t], not \s: " key 1" must not reach the next line).
  // "key-string [7] k" (a key chain, HSRP's "authentication md5 key-string k").
  /(\bkey-string[ \t]+(?:\d[ \t]+)?)(\S+)/gi,
  // OSPF "ip ospf authentication-key [7] k", NTP "ntp authentication-key 1 md5 k [7]".
  /(\bauthentication-key[ \t]+(?:\d+[ \t]+md5[ \t]+|\d[ \t]+)?)(\S+)/gi,
  // OSPF "message-digest-key 1 md5 [7] k".
  /(\bmessage-digest-key[ \t]+\d+[ \t]+md5[ \t]+(?:\d[ \t]+)?)(\S+)/gi,
  // HSRP "standby 1 authentication [text] k" (not "md5 …", which names a key chain or string).
  /(\bstandby[ \t]+\d+[ \t]+authentication[ \t]+(?:text[ \t]+)?)(?!md5\b|key-chain\b|text\b)(\S+)/gi,
  // "pre-shared-key [local|remote] k", "pre-shared-key address a [mask] key k",
  // "pre-shared-key hostname h key k"; Huawei "pre-shared-key cipher|simple k".
  /(\bpre-shared-key[ \t]+(?:(?:local|remote)[ \t]+|address[ \t]+\S+(?:[ \t]+\S+)?[ \t]+key[ \t]+|hostname[ \t]+\S+[ \t]+key[ \t]+|cipher[ \t]+|simple[ \t]+)?(?:\d[ \t]+|ascii[ \t]+|hex[ \t]+)?)(\S+)/gi,
  /(\b(?:password|cipher)\s+(?:irreversible-)?cipher\s+)(\S+)/gi,
  /(\bset\s+(?:password|passwd|psksecret|secret|key|private-key|passphrase|auth-pwd|sso-password)\s+(?:ENC\s+)?)(\S+)/gi,
  /(\b(?:encrypted-password|secret|authentication-key)\s+)("\$\d\$[^"]*"|\$\d\$\S+)/gi,
  // Cisco shared keys: "tacacs-server [host a] key [7] k", "radius-server key k",
  // "server-private a key [7] k", "crypto isakmp key k address …", BGP
  // "neighbor a password [7] k", "ppp chap password [7] k", "ppp pap
  // sent-username u password [0] k", "wpa-psk ascii 0 k".
  /(\b(?:tacacs|radius)-server\b[^\n]{0,300}?[ \t]key[ \t]+(?:\d[ \t]+)?)(\S+)/gi,
  /(\bserver-private\b[^\n]{0,300}?[ \t]key[ \t]+(?:\d[ \t]+)?)(\S+)/gi,
  /(\bcrypto[ \t]+isakmp[ \t]+key[ \t]+(?:\d[ \t]+)?)(\S+)/gi,
  /(\bneighbor[ \t]+\S+[ \t]+password[ \t]+(?:\d[ \t]+)?)(\S+)/gi,
  /(\bppp[ \t]+(?:chap[ \t]+password|pap[ \t]+sent-username[ \t]+\S+[ \t]+password)[ \t]+(?:\d[ \t]+)?)(\S+)/gi,
  /(\bwpa-psk[ \t]+(?:ascii|hex)[ \t]+(?:\d[ \t]+)?)(\S+)/gi,
  // An SNMP host's community: "snmp-server host a [vrf v] [traps|informs]
  // [version 1|2c] c" (not SNMPv3's "version 3 …", whose next word is a level).
  /(\bsnmp-server[ \t]+host[ \t]+\S+(?:[ \t]+vrf[ \t]+\S+)?(?:[ \t]+(?:traps|informs))?(?:[ \t]+version[ \t]+(?:1|2c))?[ \t]+)(?!version\b|vrf\b|traps\b|informs\b)(\S+)/gi,
  // A server block's "key 7 k" or "key k", at a line's start or after the
  // prompt it was typed at ("R1(config-radius-server)#key k"). Lower case, as
  // configurations write it ("Key points:" in a sentence is no key); a key
  // chain's " key 1" is its number (all digits) and stays.
  /^((?:[ \t]*|[^\s#>]*[#>][ \t]*)key[ \t]+\d[ \t]+)(\S+)/gm,
  /^((?:[ \t]*|[^\s#>]*[#>][ \t]*)key[ \t]+)(?!chain\b)(?=\S*[^\d\s])(\S+)/gm,
];

/** Whole-token secrets: keys with a recognisable shape, private key blocks. */
export const SECRET_TOKENS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g,
];

/** Replace passwords, keys and tokens with «SECRET», leaving everything else
 * (hosts, IPs) as is. Used before a conversation is written to disk, so secrets
 * never persist in localStorage; the Masker counts them for the send preview. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_TOKENS) out = out.replace(re, () => SECRET);
  for (const re of SECRET_RULES) out = out.replace(re, (_m, keep: string) => keep + SECRET);
  return out;
}

/** Whether `text` holds anything maskSecrets would mask. */
export function holdsMaskable(text: string): boolean {
  return maskSecrets(text) !== text;
}

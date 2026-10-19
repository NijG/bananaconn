// Minimal RFC 854 Telnet client protocol: strips IAC command sequences from the
// data stream and negotiates the options a terminal needs (echo, suppress
// go-ahead, terminal type, window size). Everything else is refused.
//
// Option state is tracked per side (RFC 1143 style): a request is answered only
// when it changes the agreed state, which both acknowledges WONT/DONT and lets
// servers toggle ECHO repeatedly (common around password prompts) without loops.

/// Longest subnegotiation we buffer; anything beyond is dropped.
const MAX_SUB: usize = 4096;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

#[derive(Clone, Copy)]
enum State {
    Data,
    Iac,
    Negotiate(u8),
    Sub,
    SubIac,
}

pub struct Parser {
    state: State,
    sub: Vec<u8>,
    /// Options the server performs (it said WILL and we agreed).
    remote: [bool; 256],
    /// Options we perform (it said DO and we agreed).
    local: [bool; 256],
    /// Refusals already sent, so a repeated unsupported request is answered once.
    refused: [[bool; 256]; 2],
    /// Set once the server asked for window-size reports.
    pub naws: bool,
}

/// Result of feeding received bytes: terminal data plus protocol replies.
pub struct Feed {
    pub data: Vec<u8>,
    pub replies: Vec<u8>,
    /// The server just enabled NAWS; the caller must send the current size.
    pub send_size: bool,
}

impl Parser {
    pub fn new() -> Self {
        Self {
            state: State::Data,
            sub: Vec::new(),
            remote: [false; 256],
            local: [false; 256],
            refused: [[false; 256]; 2],
            naws: false,
        }
    }

    pub fn feed(&mut self, input: &[u8]) -> Feed {
        let mut out = Feed {
            data: Vec::with_capacity(input.len()),
            replies: Vec::new(),
            send_size: false,
        };
        for &b in input {
            self.state = match self.state {
                State::Data => {
                    if b == IAC {
                        State::Iac
                    } else {
                        out.data.push(b);
                        State::Data
                    }
                }
                State::Iac => match b {
                    IAC => {
                        out.data.push(IAC);
                        State::Data
                    }
                    WILL | WONT | DO | DONT => State::Negotiate(b),
                    SB => {
                        self.sub.clear();
                        State::Sub
                    }
                    _ => State::Data, // NOP, GA, etc.
                },
                State::Negotiate(cmd) => {
                    self.negotiate(cmd, b, &mut out);
                    State::Data
                }
                State::Sub => {
                    if b == IAC {
                        State::SubIac
                    } else {
                        if self.sub.len() < MAX_SUB {
                            self.sub.push(b);
                        }
                        State::Sub
                    }
                }
                State::SubIac => match b {
                    SE => {
                        self.subnegotiation(&mut out);
                        State::Data
                    }
                    IAC => {
                        if self.sub.len() < MAX_SUB {
                            self.sub.push(IAC);
                        }
                        State::Sub
                    }
                    // A command inside a subnegotiation means the server never
                    // closed it: drop it and handle the command, instead of
                    // swallowing the rest of the session as subnegotiation.
                    WILL | WONT | DO | DONT => {
                        self.sub.clear();
                        State::Negotiate(b)
                    }
                    SB => {
                        self.sub.clear();
                        State::Sub
                    }
                    _ => {
                        self.sub.clear();
                        State::Data
                    }
                },
            };
        }
        out
    }

    fn negotiate(&mut self, cmd: u8, opt: u8, out: &mut Feed) {
        let idx = usize::from(opt);
        let reply = match cmd {
            // Server offers to perform an option.
            WILL if matches!(opt, OPT_ECHO | OPT_SGA) => (!self.remote[idx]).then(|| {
                self.remote[idx] = true;
                DO
            }),
            WILL => (!self.refused[0][idx]).then(|| {
                self.refused[0][idx] = true;
                DONT
            }),
            // Server stops performing it: acknowledge a change of state.
            WONT => self.remote[idx].then(|| {
                self.remote[idx] = false;
                DONT
            }),
            // Server asks us to perform an option.
            DO if matches!(opt, OPT_TTYPE | OPT_SGA | OPT_NAWS) => (!self.local[idx]).then(|| {
                self.local[idx] = true;
                if opt == OPT_NAWS {
                    self.naws = true;
                    out.send_size = true;
                }
                WILL
            }),
            DO => (!self.refused[1][idx]).then(|| {
                self.refused[1][idx] = true;
                WONT
            }),
            DONT => self.local[idx].then(|| {
                self.local[idx] = false;
                if opt == OPT_NAWS {
                    self.naws = false;
                }
                WONT
            }),
            _ => None,
        };
        if let Some(r) = reply {
            out.replies.extend_from_slice(&[IAC, r, opt]);
        }
    }
    fn subnegotiation(&mut self, out: &mut Feed) {
        if self.sub.first() == Some(&OPT_TTYPE) && self.sub.get(1) == Some(&TTYPE_SEND) {
            out.replies.extend_from_slice(&[IAC, SB, OPT_TTYPE, TTYPE_IS]);
            out.replies.extend_from_slice(b"XTERM-256COLOR");
            out.replies.extend_from_slice(&[IAC, SE]);
        }
    }
}

#[cfg(test)]
mod unterminated_sub_tests {
    use super::*;

    #[test]
    fn unterminated_subnegotiation_does_not_swallow_output() {
        let mut p = Parser::new();
        // SB TTYPE ... then a negotiation without IAC SE, then normal text.
        let f = p.feed(&[IAC, SB, OPT_TTYPE, 7, 7, IAC, DO, OPT_NAWS, b'h', b'i']);
        assert_eq!(f.data, b"hi");
        assert!(f.send_size && p.naws);
        let f = p.feed(&[IAC, DONT, OPT_NAWS]);
        assert!(!p.naws);
        assert_eq!(f.replies, [IAC, WONT, OPT_NAWS]);
    }
}

/// Encode user keystrokes for the wire: escape IAC and send Enter as CR LF.
pub fn encode_input(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + 4);
    for &b in input {
        match b {
            IAC => out.extend_from_slice(&[IAC, IAC]),
            b'\r' => out.extend_from_slice(b"\r\n"),
            _ => out.push(b),
        }
    }
    out
}

/// Window-size report (NAWS subnegotiation), escaping any 255 bytes.
pub fn naws(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = vec![IAC, SB, OPT_NAWS];
    for b in [cols.to_be_bytes(), rows.to_be_bytes()].concat() {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
    out.extend_from_slice(&[IAC, SE]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_commands_and_answers_once() {
        let mut p = Parser::new();
        let f = p.feed(&[b'h', IAC, DO, OPT_NAWS, b'i', IAC, WILL, OPT_ECHO, IAC, IAC]);
        assert_eq!(f.data, vec![b'h', b'i', IAC]);
        assert_eq!(f.replies, vec![IAC, WILL, OPT_NAWS, IAC, DO, OPT_ECHO]);
        assert!(f.send_size);
        let again = p.feed(&[IAC, DO, OPT_NAWS]);
        assert!(again.replies.is_empty());
    }

    #[test]
    fn tracks_echo_toggles_and_acknowledges_wont() {
        let mut p = Parser::new();
        assert_eq!(p.feed(&[IAC, WILL, OPT_ECHO]).replies, vec![IAC, DO, OPT_ECHO]);
        assert_eq!(p.feed(&[IAC, WONT, OPT_ECHO]).replies, vec![IAC, DONT, OPT_ECHO]);
        // Re-enabling after a WONT is answered again (no once-only lockout).
        assert_eq!(p.feed(&[IAC, WILL, OPT_ECHO]).replies, vec![IAC, DO, OPT_ECHO]);
        // Unsupported options are refused once.
        assert_eq!(p.feed(&[IAC, DO, 42]).replies, vec![IAC, WONT, 42]);
        assert!(p.feed(&[IAC, DO, 42]).replies.is_empty());
    }

    #[test]
    fn caps_subnegotiation_buffer() {
        let mut p = Parser::new();
        let mut input = vec![IAC, SB];
        input.extend(std::iter::repeat_n(7u8, 100_000));
        p.feed(&input);
        assert!(p.sub.len() <= MAX_SUB);
    }

    #[test]
    fn answers_terminal_type() {
        let mut p = Parser::new();
        let f = p.feed(&[IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
        assert!(f.replies.windows(14).any(|w| w == b"XTERM-256COLOR"));
    }

    #[test]
    fn encodes_enter_and_iac() {
        assert_eq!(encode_input(&[b'a', b'\r', IAC]), vec![b'a', b'\r', b'\n', IAC, IAC]);
        assert_eq!(naws(80, 24), vec![IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]);
    }
}

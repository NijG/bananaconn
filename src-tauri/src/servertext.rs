// Text a remote server chose (a service's greeting, a DNS TXT record, a
// certificate's names) as it is shown: the characters that would act on the
// screen or change how the text around them reads are shown as a visible
// mark, not acted on and not dropped (dropped, "exa<ZWSP>mple.com" would
// read as the real "example.com").

/// What a hidden character is shown as.
pub const MARK: char = char::REPLACEMENT_CHARACTER;

/// A character server text cannot show as it is: a control character (an
/// escape sequence, a bell), or one that changes how text around it is drawn
/// or hides it: bidi marks, embeddings, overrides and isolates (U+061C,
/// U+200E/200F, U+202A-202E, U+2066-2069), zero-width and invisible ones
/// (U+00AD, U+180E, U+200B-200D, U+2060-2065, U+FEFF), line and paragraph
/// separators (U+2028/2029) and interlinear annotation (U+FFF9-FFFB). A tab is kept.
pub fn hidden(c: char) -> bool {
    let n = c as u32;
    (c.is_control() && c != '\t')
        || matches!(n, 0x00AD | 0x061C | 0x180E | 0xFEFF)
        || (0x200B..=0x200F).contains(&n)
        || (0x2028..=0x202E).contains(&n)
        || (0x2060..=0x2069).contains(&n)
        || (0xFFF9..=0xFFFB).contains(&n)
}

/// `s` with each hidden character shown as MARK.
pub fn shown(s: &str) -> String {
    s.chars().map(|c| if hidden(c) { MARK } else { c }).collect()
}

/// Whether `s` has nothing to show but blanks and hidden characters.
pub fn blank(s: &str) -> bool {
    s.chars().all(|c| hidden(c) || c.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_characters_are_marked_and_a_tab_is_kept() {
        let ch = |n: u32| char::from_u32(n).unwrap();
        let tricky: String = ["v=spf1 ", &ch(0x202E).to_string(), "-all", &ch(0x200B).to_string(), &ch(0xFEFF).to_string(), "\x1b[2J\x07", "\tok"].concat();
        let m = MARK.to_string();
        assert_eq!(shown(&tricky), ["v=spf1 ", &m, "-all", &m, &m, &m, "[2J", &m, "\tok"].concat());
        // A look-alike name keeps a sign of what was in it.
        let spoof: String = ["exa", &ch(0x200B).to_string(), "mple.com"].concat();
        assert_ne!(shown(&spoof), "example.com");
        // Text in other scripts stays.
        assert_eq!(shown("한국어 日本語"), "한국어 日本語");
        assert!(!hidden(ch(0x2030)) && !hidden(' '));
        for n in [0x00AD, 0x061C, 0x180E, 0x200C, 0x200D, 0x2066, 0x2069, 0x200F, 0x2028, 0xFFF9, 0xFFFB] {
            assert!(hidden(ch(n)), "{n:X}");
        }
        assert!(blank("\x1b\x07 ") && blank("") && !blank("\x1b a"));
    }
}

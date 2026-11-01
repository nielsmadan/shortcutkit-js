use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingKey {
    pub context_id: String,
    pub action_id: String,
    pub binding_index: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WireModifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireKey {
    pub code: String,
    pub modifiers: WireModifiers,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireGlobalBinding {
    pub id: BindingKey,
    pub key: WireKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub attachment: String,
    pub webview: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesiredHotkey {
    pub key: WireKey,
    pub ids: Vec<BindingKey>,
}

#[derive(Clone, Debug)]
struct Attachment {
    id: String,
    webview: String,
    window: String,
    bindings: Vec<WireGlobalBinding>,
    paused: bool,
}

#[derive(Debug, Default)]
pub struct Coordinator {
    attachments: Vec<Attachment>,
}

impl Coordinator {
    pub fn sync(
        &mut self,
        attachment: &str,
        webview: &str,
        window: &str,
        bindings: Vec<WireGlobalBinding>,
        paused: bool,
    ) {
        let next = Attachment {
            id: attachment.to_owned(),
            webview: webview.to_owned(),
            window: window.to_owned(),
            bindings,
            paused,
        };
        match self.attachments.iter_mut().find(|a| a.id == attachment) {
            Some(existing) => *existing = next,
            None => self.attachments.push(next),
        }
    }

    pub fn detach(&mut self, attachment: &str) -> bool {
        self.drop_where(|a| a.id == attachment)
    }

    pub fn page_loaded(&mut self, webview: &str) -> bool {
        self.drop_where(|a| a.webview == webview)
    }

    pub fn window_destroyed(&mut self, window: &str) -> bool {
        self.drop_where(|a| a.window == window)
    }

    fn drop_where(&mut self, matches: impl Fn(&Attachment) -> bool) -> bool {
        let before = self.attachments.len();
        self.attachments.retain(|a| !matches(a));
        self.attachments.len() != before
    }

    pub fn owner(&self) -> Option<Owner> {
        self.attachments.first().map(|a| Owner {
            attachment: a.id.clone(),
            webview: a.webview.clone(),
        })
    }

    pub fn paused(&self) -> bool {
        self.attachments.iter().any(|a| a.paused)
    }

    pub fn owner_bindings(&self) -> &[WireGlobalBinding] {
        self.attachments
            .first()
            .map_or(&[], |a| a.bindings.as_slice())
    }

    pub fn desired(&self) -> Vec<DesiredHotkey> {
        if self.paused() {
            return Vec::new();
        }
        let mut desired: Vec<DesiredHotkey> = Vec::new();
        for binding in self.owner_bindings() {
            match desired.iter_mut().find(|d| d.key == binding.key) {
                Some(existing) => existing.ids.push(binding.id.clone()),
                None => desired.push(DesiredHotkey {
                    key: binding.key.clone(),
                    ids: vec![binding.id.clone()],
                }),
            }
        }
        desired
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn key(code: &str, meta: bool) -> WireKey {
        WireKey {
            code: code.to_owned(),
            modifiers: WireModifiers {
                meta,
                ..WireModifiers::default()
            },
        }
    }

    pub fn id(action: &str, index: u32) -> BindingKey {
        BindingKey {
            context_id: "app".to_owned(),
            action_id: action.to_owned(),
            binding_index: index,
        }
    }

    pub fn binding(action: &str, index: u32, code: &str) -> WireGlobalBinding {
        WireGlobalBinding {
            id: id(action, index),
            key: key(code, true),
        }
    }

    #[test]
    fn the_first_attachment_owns() {
        let mut c = Coordinator::default();
        c.sync("a", "main", "main", vec![binding("show", 0, "KeyK")], false);
        c.sync("b", "settings", "settings", vec![], false);
        assert_eq!(
            c.owner(),
            Some(Owner {
                attachment: "a".to_owned(),
                webview: "main".to_owned()
            })
        );
        assert_eq!(c.owner_bindings(), &[binding("show", 0, "KeyK")]);
    }

    #[test]
    fn a_resync_keeps_the_attach_order() {
        let mut c = Coordinator::default();
        c.sync("a", "main", "main", vec![], false);
        c.sync("b", "settings", "settings", vec![], false);
        c.sync("a", "main", "main", vec![binding("show", 0, "KeyK")], false);
        assert_eq!(c.owner().map(|o| o.attachment), Some("a".to_owned()));
        assert_eq!(c.owner_bindings(), &[binding("show", 0, "KeyK")]);
    }

    #[test]
    fn detach_page_load_and_destroy_hand_over_in_attach_order() {
        let mut c = Coordinator::default();
        c.sync("a", "main", "main", vec![], false);
        c.sync("b", "settings", "settings", vec![], false);
        c.sync("c", "peer", "peer-window", vec![], false);
        c.sync("d", "other", "other", vec![], false);
        assert!(c.detach("a"));
        assert_eq!(c.owner().map(|o| o.attachment), Some("b".to_owned()));
        assert!(c.page_loaded("settings"));
        assert_eq!(c.owner().map(|o| o.attachment), Some("c".to_owned()));
        assert!(c.window_destroyed("peer-window"));
        assert_eq!(c.owner().map(|o| o.attachment), Some("d".to_owned()));
        assert!(!c.page_loaded("main"));
    }

    #[test]
    fn any_paused_attachment_empties_desired() {
        let mut c = Coordinator::default();
        c.sync("a", "main", "main", vec![binding("show", 0, "KeyK")], false);
        c.sync("b", "settings", "settings", vec![], true);
        assert!(c.paused());
        assert_eq!(c.desired(), vec![]);
        c.sync("b", "settings", "settings", vec![], false);
        assert_eq!(c.desired().len(), 1);
    }

    #[test]
    fn desired_deduplicates_by_key() {
        let mut c = Coordinator::default();
        c.sync(
            "a",
            "main",
            "main",
            vec![
                binding("show", 0, "KeyK"),
                binding("hide", 0, "KeyK"),
                binding("show", 1, "KeyJ"),
            ],
            false,
        );
        assert_eq!(
            c.desired(),
            vec![
                DesiredHotkey {
                    key: key("KeyK", true),
                    ids: vec![id("show", 0), id("hide", 0)],
                },
                DesiredHotkey {
                    key: key("KeyJ", true),
                    ids: vec![id("show", 1)],
                },
            ]
        );
    }
}

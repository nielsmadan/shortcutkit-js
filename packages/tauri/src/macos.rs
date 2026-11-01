use std::ffi::c_void;

type CfTypeRef = *const c_void;
type OsStatus = i32;

const KEY_ACTION_DISPLAY: u16 = 3;
const NO_DEAD_KEYS: u32 = 1;
const BUFFER_LEN: usize = 4;
const CF_NUMBER_SINT64: isize = 4;
const CF_STRING_UTF8: u32 = 0x0800_0100;

// The dictionary keys are C macros in HIToolbox, not exported symbols.
const KEY_ENABLED: &str = "kHISymbolicHotKeyEnabled";
const KEY_CODE: &str = "kHISymbolicHotKeyCode";
const KEY_MODIFIERS: &str = "kHISymbolicHotKeyModifiers";

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyUnicodeKeyLayoutData: CfTypeRef;

    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> CfTypeRef;
    fn TISGetInputSourceProperty(source: CfTypeRef, key: CfTypeRef) -> CfTypeRef;
    fn LMGetKbdType() -> u8;
    fn CopySymbolicHotKeys(out: *mut CfTypeRef) -> OsStatus;
    fn UCKeyTranslate(
        layout: *const c_void,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        options: u32,
        dead_key_state: *mut u32,
        max_len: usize,
        actual_len: *mut usize,
        unicode: *mut u16,
    ) -> OsStatus;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDataGetBytePtr(data: CfTypeRef) -> *const u8;
    fn CFRelease(object: CfTypeRef);
    fn CFGetTypeID(object: CfTypeRef) -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(array: CfTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CfTypeRef, index: isize) -> CfTypeRef;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFDictionaryGetValue(dictionary: CfTypeRef, key: CfTypeRef) -> CfTypeRef;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(number: CfTypeRef, kind: isize, out: *mut i64) -> u8;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(boolean: CfTypeRef) -> u8;
    fn CFStringCreateWithBytes(
        allocator: CfTypeRef,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        is_external: u8,
    ) -> CfTypeRef;
}

struct Owned(CfTypeRef);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the pointer came from a Copy or Create call and is released exactly once.
        unsafe { CFRelease(self.0) }
    }
}

// Callers must be on the main thread: TIS and LMGetKbdType are main-thread only.
pub(crate) unsafe fn translate_all(
    codes: impl Iterator<Item = (&'static str, u16)>,
) -> Option<Vec<(&'static str, String)>> {
    // SAFETY: the Copy-rule source is owned by `source` until the end of this function, and
    // the layout data it returns is read only while `source` is alive.
    unsafe {
        let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
        if source.is_null() {
            return None;
        }
        let source = Owned(source);
        let data = TISGetInputSourceProperty(source.0, kTISPropertyUnicodeKeyLayoutData);
        if data.is_null() {
            return None;
        }
        let layout = CFDataGetBytePtr(data);
        if layout.is_null() {
            return None;
        }
        let keyboard_type = u32::from(LMGetKbdType());
        let entries = codes
            .filter_map(|(code, key)| {
                let mut dead_key_state = 0_u32;
                let mut length = 0_usize;
                let mut buffer = [0_u16; BUFFER_LEN];
                let status = UCKeyTranslate(
                    layout.cast(),
                    key,
                    KEY_ACTION_DISPLAY,
                    0,
                    keyboard_type,
                    NO_DEAD_KEYS,
                    &raw mut dead_key_state,
                    BUFFER_LEN,
                    &raw mut length,
                    buffer.as_mut_ptr(),
                );
                (status == 0).then(|| {
                    (
                        code,
                        String::from_utf16_lossy(&buffer[..length.min(BUFFER_LEN)]),
                    )
                })
            })
            .collect();
        Some(entries)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RawHotKey {
    pub enabled: Option<bool>,
    pub code: Option<i64>,
    pub modifiers: Option<i64>,
}

unsafe fn lookup(dictionary: CfTypeRef, name: &str) -> CfTypeRef {
    // SAFETY: the caller passes a live CFDictionary; the key string is released on return.
    unsafe {
        let key = CFStringCreateWithBytes(
            std::ptr::null(),
            name.as_ptr(),
            name.len().cast_signed(),
            CF_STRING_UTF8,
            0,
        );
        if key.is_null() {
            return std::ptr::null();
        }
        let key = Owned(key);
        CFDictionaryGetValue(dictionary, key.0)
    }
}

unsafe fn number(value: CfTypeRef) -> Option<i64> {
    // SAFETY: the type is checked before the value is read as a CFNumber.
    unsafe {
        if value.is_null() || CFGetTypeID(value) != CFNumberGetTypeID() {
            return None;
        }
        let mut out = 0_i64;
        (CFNumberGetValue(value, CF_NUMBER_SINT64, &raw mut out) != 0).then_some(out)
    }
}

unsafe fn boolean(value: CfTypeRef) -> Option<bool> {
    // SAFETY: the type is checked before the value is read as a CFBoolean.
    unsafe {
        if value.is_null() || CFGetTypeID(value) != CFBooleanGetTypeID() {
            return None;
        }
        Some(CFBooleanGetValue(value) != 0)
    }
}

// Returns an empty list when Carbon reports an error. Must run on the main thread.
pub(crate) unsafe fn symbolic_hotkeys() -> Vec<RawHotKey> {
    // SAFETY: the array follows the Create rule and is owned by `array` until the end of this
    // function; its elements and their values are only read while it is alive.
    unsafe {
        let mut raw: CfTypeRef = std::ptr::null();
        if CopySymbolicHotKeys(&raw mut raw) != 0 || raw.is_null() {
            return Vec::new();
        }
        let array = Owned(raw);
        if CFGetTypeID(array.0) != CFArrayGetTypeID() {
            return Vec::new();
        }
        (0..CFArrayGetCount(array.0))
            .filter_map(|index| {
                let entry = CFArrayGetValueAtIndex(array.0, index);
                if entry.is_null() || CFGetTypeID(entry) != CFDictionaryGetTypeID() {
                    return None;
                }
                Some(RawHotKey {
                    enabled: boolean(lookup(entry, KEY_ENABLED)),
                    code: number(lookup(entry, KEY_CODE)),
                    modifiers: number(lookup(entry, KEY_MODIFIERS)),
                })
            })
            .collect()
    }
}

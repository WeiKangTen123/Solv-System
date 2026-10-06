import { useEffect, useRef } from 'react';

// Open dialogs, newest last. Escape belongs to the top one: "Undo import?"
// over the import panel used to close both.
const _stack = [];

// The one overlay. Six dialogs each drew their own fixed backdrop, their own
// Escape handler (or none) and their own click-outside rule, with small
// differences between them. This owns: the backdrop, Escape and click-outside
// (both refused while `busy`, so a dialog mid-save cannot be dismissed), the
// dialog semantics a screen reader needs, and initial focus on the panel so
// Escape works without clicking into it first. The caller draws its own
// header and body; only the frame is shared.
//
// `card` uses the .card class (the import and intake dialogs); otherwise the
// panel paints its own surface. `style` lands on the panel for padding and
// height tweaks.
export default function Modal({ onClose, busy = false, maxWidth = 440, zIndex = 1000, card = false, label, style, children }) {
  const panelRef = useRef(null);

  const me = useRef({});
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // On open: join the stack, take focus, remember where focus was. On close:
  // leave the stack and give focus back to what opened the dialog.
  useEffect(() => {
    const token = me.current;
    _stack.push(token);
    const opener = document.activeElement;
    panelRef.current?.focus();
    function onKey(e) {
      if (_stack[_stack.length - 1] !== token) return;
      if (e.key === 'Escape' && !busyRef.current) { e.stopPropagation(); closeRef.current?.(); return; }
      // Tab stays inside the dialog.
      if (e.key === 'Tab' && panelRef.current) {
        const items = [...panelRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const at = _stack.indexOf(token);
      if (at !== -1) _stack.splice(at, 1);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, []);

  const panel = {
    width: '100%', maxWidth, maxHeight: '90vh', overflowY: 'auto', borderRadius: 18,
    boxShadow: 'var(--shadow-lg)', animation: 'scaleIn 0.2s ease', outline: 'none',
    ...(card ? {} : { background: 'var(--bg-card)', border: '1px solid var(--border)', padding: '26px 28px 22px' }),
    ...style,
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
               display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'fadeIn 0.15s ease' }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose?.(); }}
    >
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label}
           className={card ? 'card' : undefined} style={panel}>
        {children}
      </div>
    </div>
  );
}

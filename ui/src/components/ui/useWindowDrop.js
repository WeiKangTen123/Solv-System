import { createElement, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { filesFromDrop, hasFiles } from './dropFiles';

// Lets a whole page take dropped files (Home, the case page): drag receipts
// from the desktop anywhere over the window and a full-page overlay says where
// they will go; drop, and onFiles gets them. Without it a drop that missed the
// drop zone made the browser open the file instead of the app.
//
// A DropZone on the same page keeps its own drops: it marks them handled
// (preventDefault) and this leaves those alone, so nothing is added twice. A
// drag that began on the page itself (an image, a link) is not a file being
// added and is ignored. Folders are walked as DropZone does.
//
//   const drop = useWindowDrop(files => send(files), { enabled: canAdd, label: 'Drop to add to C-0012' });
//   return <>{drop.overlay} ...page... </>;
//
// Options:
//   enabled  listen at all (default true). Off while a dialog is open, or on
//            a case that cannot take receipts.
//   label    what the overlay says (default "Drop to add them").
// Returns { dragging, overlay }: `overlay` is an element to render anywhere in
// the page (it draws itself over the window), null when nothing is dragged.
export function useWindowDrop(onFiles, { enabled = true, label = 'Drop to add them' } = {}) {
  const [dragging, setDragging] = useState(false);
  const cb = useRef(onFiles);
  useEffect(() => { cb.current = onFiles; });

  useEffect(() => {
    if (!enabled) { setDragging(false); return undefined; }
    let depth = 0;        // see DropZone: enter and leave fire per element crossed
    let inside = false;   // the drag started on this page
    const ours = e => !inside && hasFiles(e.dataTransfer);
    const reset = () => { depth = 0; setDragging(false); };

    const onStart = () => { inside = true; };
    const onEnd = () => { inside = false; reset(); };
    const onEnter = e => { if (!ours(e)) return; depth += 1; setDragging(true); };
    const onLeave = e => { if (!ours(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onOver = e => {
      if (!ours(e) || e.defaultPrevented) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = e => {
      const take = ours(e) && !e.defaultPrevented;
      reset();
      if (!take) return;
      e.preventDefault();
      filesFromDrop(e.dataTransfer).then(files => { if (files.length) cb.current?.(files); });
    };

    const on = { dragstart: onStart, dragend: onEnd, dragenter: onEnter, dragleave: onLeave, dragover: onOver, drop: onDrop };
    for (const [k, fn] of Object.entries(on)) window.addEventListener(k, fn);
    return () => {
      for (const [k, fn] of Object.entries(on)) window.removeEventListener(k, fn);
      setDragging(false);
    };
  }, [enabled]);

  // createElement rather than JSX keeps this a plain .js module.
  const overlay = dragging
    ? createPortal(
      createElement('div', { className: 'ui-drop-overlay', 'aria-hidden': 'true' },
        createElement('div', { className: 'ui-drop-overlay-panel' }, label)),
      document.body)
    : null;
  return { dragging, overlay };
}

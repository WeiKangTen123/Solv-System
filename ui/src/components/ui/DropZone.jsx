import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { useViewMode } from '../../context/ViewModeContext';
import { filesFromDrop, hasFiles } from './dropFiles';

export { useWindowDrop } from './useWindowDrop';

// The place receipts are dropped or picked: drag files (or a folder of them)
// onto it, click it, or focus it and press Enter or Space to open the file
// picker. On a phone, where nothing is dragged, it reads "Tap to choose".
//
// While a drag with files is over it, it says "Drop to add them" and is drawn
// as a target (.is-over), so it is plain where the files will land. A drop on
// it never reaches the browser, which would otherwise open the file in place
// of the app and lose the page. While `disabled` it shows as such, refuses the
// drag (the cursor says no) and ignores the drop and the keys.
//
// It hands over every file, not only the wanted types, as File[] (never a
// FileList): the uploader decides what it cannot take and says so per file.
// `accept` only narrows what the picker offers. A ref gets { open() }, for a
// "Choose files" button elsewhere that should open the same picker.
//
// Props:
//   onFiles   fn(File[]), called with at least one file.
//   accept    the picker's accept attribute (".jpg,.png,.pdf,image/*").
//   multiple  allow several at once (default true); otherwise only the first
//             file of a drop is passed on.
//   disabled  show it, but take nothing.
//   compact   a single slim line, for a case page that already has receipts.
//   label     the main line; the default depends on phone or desktop.
//   children  a quieter line under it (what is accepted, a size limit). It is
//             inside the button, so nothing in it may be interactive: put
//             other buttons beside the zone, not in it.
const DropZone = forwardRef(function DropZone({ onFiles, accept, multiple = true, disabled = false, compact = false, label, children }, ref) {
  const { isMobile } = useViewMode();
  const inputRef = useRef(null);
  // dragenter and dragleave fire for every child the pointer crosses, so one
  // pair does not mean the drag left the zone: only a count back at 0 does.
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const open = () => { if (!disabled) inputRef.current?.click(); };
  useImperativeHandle(ref, () => ({ open }));

  function give(list) {
    const files = Array.from(list || []);
    if (files.length) onFiles?.(multiple ? files : files.slice(0, 1));
  }

  function onDragEnter(e) {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth.current += 1;
    if (!disabled) setOver(true);
  }
  function onDragOver(e) {
    if (!hasFiles(e.dataTransfer)) return;
    // Without this the drop never fires and the browser opens the file.
    e.preventDefault();
    e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }
  function onDragLeave(e) {
    if (!hasFiles(e.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (!depth.current) setOver(false);
  }
  function onDrop(e) {
    // Prevented even while disabled: it also tells a page-wide drop
    // (useWindowDrop) that this drop has been dealt with.
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    if (!disabled) filesFromDrop(e.dataTransfer).then(give);
  }
  function onKeyDown(e) {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    open();
  }

  const main = over ? 'Drop to add them' : (label || (isMobile ? 'Tap to choose files' : 'Drop files here, or click to choose'));
  const cls = ['ui-dropzone', compact && 'is-compact', over && 'is-over', disabled && 'is-disabled'].filter(Boolean).join(' ');

  return (
    <>
      <div role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} className={cls}
           onClick={open} onKeyDown={onKeyDown}
           onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <span className="ui-dropzone-mark" aria-hidden="true">+</span>
        <span className="ui-dropzone-text">
          <span className="ui-dropzone-label">{main}</span>
          {children && <span className="ui-dropzone-hint">{children}</span>}
        </span>
      </div>
      {/* Reset after each pick, so choosing the same file again still counts. */}
      <input ref={inputRef} type="file" hidden tabIndex={-1} accept={accept} multiple={multiple} disabled={disabled}
             onChange={e => { give(e.target.files); e.target.value = ''; }} />
    </>
  );
});

export default DropZone;

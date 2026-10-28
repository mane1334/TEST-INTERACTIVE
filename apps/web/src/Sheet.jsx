import React, { useEffect, useRef } from 'react';

export default function Sheet({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current && ref.current.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev && prev.focus && prev.focus(); };
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet kt-sheet stack" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="kt-sheet__grip" aria-hidden="true" />
        <div className="row row--between">
          <h2 className="kt-display">{title}</h2>
          <button className="kt-btn kt-btn--glass" onClick={onClose} aria-label="Fechar">Fechar</button>
        </div>
        {children}
      </div>
    </div>
  );
}

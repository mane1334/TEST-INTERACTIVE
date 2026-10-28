import React, { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import { STATUS, formatPrice, dishImages, progressPercent, secondsLeft } from './lib.js';

const MAX_QTY = 50;

export function TraySheet({ tray, dishesById, currency, tableNumber, onChange, onSend, onClose }) {
  const [table, setTable] = useState(tableNumber || '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entries = Object.entries(tray).filter(([, q]) => q > 0).map(([id, qty]) => ({ dish: dishesById.get(Number(id)), qty })).filter((e) => e.dish);
  const total = entries.reduce((s, e) => s + Number(e.dish.price) * e.qty, 0);

  const send = async () => {
    if (!table.trim()) { setError('Indica o número da mesa.'); return; }
    setBusy(true); setError('');
    try { await onSend(table.trim(), notes.trim()); }
    catch (e) { setError(e.message || 'Não foi possível enviar o pedido.'); setBusy(false); }
  };

  return (
    <Sheet title="A tua bandeja" onClose={onClose}>
      {entries.length === 0 ? <p className="kt-muted">A bandeja está vazia. Toca em Pedir num prato.</p> : (
        <>
          <div className="stack">
            {entries.map(({ dish, qty }) => (
              <div className="row kt-card kt-card--item" key={dish.id} style={{ padding: 12 }}>
                {dishImages(dish)[0] ? <img className="thumb" src={dishImages(dish)[0]} alt="" /> : <div className="thumb" />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{dish.name}</div>
                  <div className="kt-muted" style={{ fontSize: 14 }}>{formatPrice(dish.price, currency)}</div>
                </div>
                <div className="stepper">
                  <button className="kt-btn" aria-label={`Menos ${dish.name}`} onClick={() => onChange(dish.id, qty - 1)}>−</button>
                  <span aria-live="polite">{qty}</span>
                  <button className="kt-btn" aria-label={`Mais ${dish.name}`} disabled={qty >= MAX_QTY} onClick={() => onChange(dish.id, qty + 1)}>+</button>
                </div>
              </div>
            ))}
          </div>
          {!tableNumber && (
            <div>
              <label htmlFor="mesa" className="kt-muted" style={{ fontSize: 13 }}>Mesa</label>
              <input id="mesa" className="kt-input" inputMode="numeric" value={table} onChange={(e) => setTable(e.target.value)} placeholder="Ex.: 3" />
            </div>
          )}
          <div>
            <label htmlFor="nota" className="kt-muted" style={{ fontSize: 13 }}>Nota para a cozinha (opcional)</label>
            <input id="nota" className="kt-input" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: sem piri-piri" />
          </div>
          <div className="row row--between"><span className="kt-muted">Total</span><span className="total kt-display">{formatPrice(total, currency)}</span></div>
          {error ? <div className="kt-notice kt-notice--error" role="alert">{error}</div> : null}
          <button className="kt-btn kt-btn--primary kt-btn--lg" disabled={busy} onClick={send}>{busy ? 'A enviar…' : 'Enviar à cozinha'}</button>
          <div className="kt-muted" style={{ textAlign: 'center', fontSize: 13 }}>Pagas no fim, à mesa.</div>
        </>
      )}
    </Sheet>
  );
}

function Rating({ order, onRate }) {
  const [stars, setStars] = useState(0);
  const [sent, setSent] = useState(false);
  if (order.rated || sent) return <div className="kt-notice">Obrigado pela tua avaliação.</div>;
  return (
    <div className="stack">
      <div style={{ fontWeight: 700 }}>Como estava a refeição?</div>
      <div className="stars" role="radiogroup" aria-label="Avaliação de 1 a 5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} role="radio" aria-checked={stars === n} aria-label={`${n} ${n === 1 ? 'estrela' : 'estrelas'}`} className={`kt-btn ${n <= stars ? 'kt-btn--primary' : ''}`} onClick={() => setStars(n)}>★</button>
        ))}
      </div>
      <button className="kt-btn kt-btn--ghost" disabled={!stars} onClick={async () => { await onRate(order.id, stars); setSent(true); }}>Enviar avaliação</button>
    </div>
  );
}

export function OrdersSheet({ orders, currency, onCancel, onRate, onClose }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return (
    <Sheet title="Os teus pedidos" onClose={onClose}>
      {orders.length === 0 ? <p className="kt-muted">Ainda não fizeste nenhum pedido.</p> : orders.map((o) => {
        const st = STATUS[o.status] || STATUS.pending;
        const left = secondsLeft(o.cancel_until, now);
        const canCancel = o.status === 'pending' && left > 0;
        return (
          <div className="kt-card stack" key={o.id}>
            <div className="row row--between"><b>Pedido #{o.id}</b><span className="kt-muted" style={{ fontSize: 13 }}>Mesa {o.table_number}</span></div>
            <div className="kt-display" style={{ fontSize: 24 }}>{st.label}</div>
            <div className="kt-muted" style={{ fontSize: 14 }}>{st.hint}</div>
            {o.status !== 'cancelled' && <div className="kt-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(o.status)} aria-label="Estado do pedido"><span style={{ width: `${progressPercent(o.status)}%` }} /></div>}
            {o.notes ? <div className="kt-muted" style={{ fontSize: 14 }}>Nota: {o.notes}</div> : null}
            <div style={{ fontSize: 15, lineHeight: 1.6 }}>
              {(o.lines || []).map((l) => <div className="row row--between" key={l.name}><span>{l.qty}× {l.name}</span></div>)}
              <div className="row row--between" style={{ marginTop: 6, fontWeight: 700 }}><span>Total</span><span>{formatPrice(o.total, currency)}</span></div>
            </div>
            {canCancel && <button className="kt-btn kt-btn--ghost" onClick={() => onCancel(o.id)}>Cancelar pedido ({Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')})</button>}
            {o.status === 'completed' && <Rating order={o} onRate={onRate} />}
          </div>
        );
      })}
    </Sheet>
  );
}

export function ServiceSheet({ tableNumber, onCall, onClose }) {
  const [table, setTable] = useState(tableNumber || '');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const call = async (reason) => {
    if (!table.trim()) { setError('Indica o número da mesa.'); return; }
    setError('');
    try { await onCall(table.trim(), reason); setMsg('Já avisámos a equipa. Alguém vai à tua mesa.'); }
    catch (e) { setError(e.message || 'Não foi possível avisar a equipa.'); }
  };
  return (
    <Sheet title="Precisas de ajuda?" onClose={onClose}>
      {!tableNumber && (
        <div>
          <label htmlFor="mesa2" className="kt-muted" style={{ fontSize: 13 }}>Mesa</label>
          <input id="mesa2" className="kt-input" inputMode="numeric" value={table} onChange={(e) => setTable(e.target.value)} placeholder="Ex.: 3" />
        </div>
      )}
      <div className="row" style={{ gap: 12 }}>
        <button className="kt-btn kt-btn--lg" style={{ flex: 1 }} onClick={() => call('Chamado Geral')}>Chamar funcionário</button>
        <button className="kt-btn kt-btn--lg" style={{ flex: 1 }} onClick={() => call('Pedir a conta')}>Pedir a conta</button>
      </div>
      {msg ? <div className="kt-notice" role="status">{msg}</div> : null}
      {error ? <div className="kt-notice kt-notice--error" role="alert">{error}</div> : null}
    </Sheet>
  );
}

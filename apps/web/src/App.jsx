import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Feed from './Feed.jsx';
import { TraySheet, OrdersSheet, ServiceSheet } from './Sheets.jsx';
import { api, openEvents, restaurantId, store, tableNumber } from './api.js';
import { groupCategories, trayCount, trayToItems } from './lib.js';

const ACCENTS = ['brasa', 'floresta', 'oceano', 'ouro'];

export default function App() {
  const [dishes, setDishes] = useState(null);
  const [settings, setSettings] = useState({});
  const [error, setError] = useState('');
  const [category, setCategory] = useState('Todos');
  const [tray, setTray] = useState(() => store.get('tray', {}));
  const [orders, setOrders] = useState(() => store.get('orders', []));
  const [favorites, setFavorites] = useState(() => store.get('favs', []));
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  const currency = settings.currency || 'MT';
  const say = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, []);

  // Carregar cardápio e definições
  useEffect(() => {
    if (!restaurantId) { setError('Falta o restaurante no endereço (?r=…).'); return; }
    Promise.all([api.menu(), api.settings().catch(() => ({}))])
      .then(([menu, s]) => { setDishes(menu); setSettings(s || {}); })
      .catch((e) => setError(e.message));
  }, []);

  // Tema e título
  useEffect(() => {
    const accent = ACCENTS.includes(settings.accent) ? settings.accent : 'brasa';
    document.documentElement.setAttribute('data-accent', accent);
    if (settings.restaurant_name) document.title = settings.restaurant_name;
  }, [settings]);

  useEffect(() => store.set('tray', tray), [tray]);
  useEffect(() => store.set('orders', orders), [orders]);
  useEffect(() => store.set('favs', favorites), [favorites]);

  const dishesById = useMemo(() => new Map((dishes || []).map((d) => [d.id, d])), [dishes]);
  const categories = useMemo(() => groupCategories(dishes || []), [dishes]);
  const visible = useMemo(() => (dishes || []).filter((d) => category === 'Todos' || (d.category_name || 'Outros') === category), [dishes, category]);

  // Tempo real: só os meus pedidos
  const patchOrder = useCallback((id, patch) => setOrders((list) => list.map((o) => (o.id === id ? { ...o, ...patch } : o))), []);
  useEffect(() => {
    if (!restaurantId) return undefined;
    return openEvents((ev) => {
      const p = ev.payload || {};
      const id = Number(p.id ?? p.order_id);
      if (!id) return;
      if (ev.type === 'ORDER_STATUS_UPDATE' || ev.type === 'ORDER_CANCELLED') patchOrder(id, { status: p.status || 'cancelled' });
      if (ev.type === 'PREP_TIME_UPDATE') patchOrder(id, { prep_time_seconds: p.prep_time_seconds });
      if (ev.type === 'COURTESY_MESSAGE') say(p.message || 'A cozinha demora um pouco mais.');
    });
  }, [patchOrder, say]);

  // Reconciliar estados ao abrir (caso o WebSocket tenha falhado)
  useEffect(() => {
    orders.filter((o) => o.status === 'pending' || o.status === 'preparing').forEach((o) => {
      api.getOrder(o.id, o.access_code).then((srv) => patchOrder(o.id, { status: srv.status, cancel_until: srv.cancel_until })).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeQty = (id, qty) => setTray((t) => {
    const next = { ...t };
    if (qty <= 0) delete next[id]; else next[id] = Math.min(qty, 50);
    return next;
  });
  const add = (dish) => { changeQty(dish.id, (tray[dish.id] || 0) + 1); say(`${dish.name} na bandeja`); };
  const toggleFav = (id) => setFavorites((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const share = async (dish) => {
    const url = `${window.location.origin}${window.location.pathname}?r=${restaurantId}`;
    try {
      if (navigator.share) await navigator.share({ title: dish.name, url });
      else { await navigator.clipboard.writeText(url); say('Ligação copiada'); }
    } catch (_) { /* cancelado */ }
  };

  const sendOrder = async (table, notes) => {
    const items = trayToItems(tray);
    const res = await api.createOrder(table, items, notes);
    const lines = items.map((i) => ({ name: dishesById.get(i.dish_id)?.name || `Prato ${i.dish_id}`, qty: i.quantity }));
    const total = items.reduce((s, i) => s + Number(dishesById.get(i.dish_id)?.price || 0) * i.quantity, 0);
    setOrders((list) => [{ id: res.order_id, access_code: res.access_code, notes: notes || null, table_number: table, status: 'pending', total, lines, cancel_until: res.cancel_until, prep_time_seconds: res.prep_time_seconds }, ...list].slice(0, 20));
    setTray({});
    setToast('');
    setSheet('orders');
  };

  const cancel = async (id) => {
    try { const r = await api.cancelOrder(id, orders.find((o) => o.id === id)?.access_code); patchOrder(id, { status: r.status || 'cancelled' }); say('Pedido cancelado'); }
    catch (e) { say(e.message); }
  };
  const rate = async (orderId, rating) => {
    try { await api.rate({ order_id: orderId, rating }); patchOrder(orderId, { rated: true }); }
    catch (e) { say(e.message); }
  };

  if (error) return <div className="kt-app center" role="alert"><div><h1 className="kt-display">Não foi possível abrir o cardápio</h1><p className="kt-muted">{error}</p></div></div>;
  if (!dishes) return <div className="kt-app center" role="status"><span className="kt-muted">A carregar o cardápio…</span></div>;
  if (dishes.length === 0) return <div className="kt-app center"><div><h1 className="kt-display">Cardápio vazio</h1><p className="kt-muted">Este restaurante ainda não tem pratos disponíveis.</p></div></div>;

  const openSheet = (name) => { setToast(''); setSheet(name); };
  const count = trayCount(tray);
  const activeOrders = orders.filter((o) => o.status === 'pending' || o.status === 'preparing').length;

  return (
    <div className="kt-app">
      <header className="topbar">
        <div className="topbar__row">
          <div className="topbar__name kt-display">{settings.restaurant_name || 'Cardápio'}</div>
          <div className="row" style={{ gap: 8 }}>
            {orders.length > 0 && <button className="kt-chip" onClick={() => openSheet('orders')}>Pedidos{activeOrders ? ` · ${activeOrders}` : ''}</button>}
            {tableNumber && <div className="topbar__table">Mesa {tableNumber}</div>}
          </div>
        </div>
        <div className="chips" role="tablist" aria-label="Categorias">
          {['Todos', ...categories.map((c) => c.name)].map((name) => (
            <button key={name} role="tab" aria-selected={category === name} className={`kt-chip${category === name ? ' kt-chip--active' : ''}`} onClick={() => { setCategory(name); document.getElementById('feed')?.scrollTo({ top: 0 }); }}>{name}</button>
          ))}
        </div>
      </header>
      <Feed dishes={visible} currency={currency} favorites={favorites} onFavorite={toggleFav} onShare={share} onAdd={add} onService={() => openSheet('service')} trayCount={count} onOpenTray={() => openSheet('tray')} />
      {sheet === 'tray' && <TraySheet tray={tray} dishesById={dishesById} currency={currency} tableNumber={tableNumber} onChange={changeQty} onSend={sendOrder} onClose={() => setSheet(null)} />}
      {sheet === 'orders' && <OrdersSheet orders={orders} currency={currency} onCancel={cancel} onRate={rate} onClose={() => setSheet(null)} />}
      {sheet === 'service' && <ServiceSheet tableNumber={tableNumber} onCall={api.callWaiter} onClose={() => setSheet(null)} />}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { dishImages, formatPrice } from './lib.js';

// Vídeo do prato: só toca quando está no ecrã (60%), sem som, e não gasta dados em modo poupança.
function DishVideo({ src, poster }) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(() => {
    const saveData = typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData;
    const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return Boolean(saveData || reduced);
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || blocked || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) el.play().catch(() => {});
      else el.pause();
    }, { threshold: [0, 0.6, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, [blocked]);

  return (
    <>
      <video ref={ref} className="slide__bg" src={blocked ? undefined : src} poster={poster} muted loop playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
      {blocked && <button className="kt-btn kt-btn--glass" style={{ position: 'absolute', left: '50%', top: '40%', transform: 'translateX(-50%)' }} onClick={() => setBlocked(false)}>Ver vídeo</button>}
    </>
  );
}

const Icon = ({ d }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={d} /></svg>
);
const HEART = 'M12 21s-7-4.4-9.3-9A5.3 5.3 0 0 1 12 6a5.3 5.3 0 0 1 9.3 6C19 16.6 12 21 12 21z';
const SHARE = 'M4 12v7h16v-7M12 3v12M7 8l5-5 5 5';
const BELL = 'M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4';

export default function Feed({ dishes, currency, favorites, onFavorite, onShare, onAdd, onService, trayCount, onOpenTray }) {
  return (
    <main className="feed" id="feed">
      {dishes.map((dish) => {
        const images = dishImages(dish);
        const soldOut = dish.is_available === 0 || dish.is_available === false;
        const fav = favorites.includes(dish.id);
        return (
          <section key={dish.id} className={`slide${soldOut ? ' slide--soldout' : ''}`} aria-label={dish.name} data-dish={dish.id}>
            {dish.video_url
              ? <DishVideo src={dish.video_url} poster={images[0]} />
              : images[0]
              ? <img className="slide__bg" src={images[0]} alt="" loading="lazy" decoding="async" />
              : <div className="slide__bg" style={{ background: 'radial-gradient(120% 70% at 50% 28%, #7A3B1D 0%, #3A1D10 45%, #0F0D0B 80%)' }} />}
            <div className="slide__shade" />
            <div className="slide__rail">
              <button className="kt-btn kt-btn--glass kt-btn--icon" aria-label={fav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'} aria-pressed={fav} onClick={() => onFavorite(dish.id)} style={fav ? { color: 'var(--kt-accent)' } : null}><Icon d={HEART} /></button>
              <button className="kt-btn kt-btn--glass kt-btn--icon" aria-label="Partilhar" onClick={() => onShare(dish)}><Icon d={SHARE} /></button>
              <button className="kt-btn kt-btn--glass kt-btn--icon" aria-label="Chamar funcionário" onClick={onService}><Icon d={BELL} /></button>
            </div>
            <div className="slide__info">
              <div className="slide__tags">
                {dish.is_spicy ? <span className="kt-badge">Picante</span> : null}
                {dish.is_vegetarian ? <span className="kt-badge">Vegetariano</span> : null}
                {dish.is_gluten_free ? <span className="kt-badge">Sem glúten</span> : null}
                {dish.preparation_time ? <span className="kt-badge">{dish.preparation_time} min</span> : null}
                {soldOut ? <span className="kt-badge">Esgotado</span> : null}
              </div>
              <h1 className="slide__title kt-display">{dish.name}</h1>
              {dish.description ? <p className="slide__desc">{dish.description}</p> : null}
              <div className="slide__price kt-display">{formatPrice(dish.price, currency)}</div>
            </div>
            <div className="slide__actions">
              <button className="kt-btn kt-btn--primary kt-btn--lg" disabled={soldOut} onClick={() => onAdd(dish)}>{soldOut ? 'Esgotado' : 'Pedir'}</button>
              <button className="kt-btn kt-btn--glass kt-btn--lg" onClick={onOpenTray}>Bandeja{trayCount ? ` · ${trayCount}` : ''}</button>
            </div>
          </section>
        );
      })}
    </main>
  );
}

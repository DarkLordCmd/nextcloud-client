import { useCallback, useEffect, useRef, useState } from 'react';

const ACTIVATE_DIST = 4;
const SCROLL_EDGE = 40;
const SCROLL_MAX = 24;

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function marqueeRect(startX, startY, curX, curY) {
  return {
    left: Math.min(startX, curX),
    top: Math.min(startY, curY),
    right: Math.max(startX, curX),
    bottom: Math.max(startY, curY),
  };
}

function clipRect(rect, bounds) {
  return {
    left: Math.max(rect.left, bounds.left),
    top: Math.max(rect.top, bounds.top),
    right: Math.min(rect.right, bounds.right),
    bottom: Math.min(rect.bottom, bounds.bottom),
  };
}

export default function useMarquee({ containerRef, getItems, getSelection, onReplace, onClear }) {
  const [style, setStyle] = useState(null);
  const dragRef = useRef(null);
  const rafRef = useRef(0);
  const getItemsRef = useRef(getItems);
  const getSelectionRef = useRef(getSelection);
  const onReplaceRef = useRef(onReplace);
  const onClearRef = useRef(onClear);

  useEffect(() => {
    getItemsRef.current = getItems;
    getSelectionRef.current = getSelection;
    onReplaceRef.current = onReplace;
    onClearRef.current = onClear;
  });

  const stopAutoScroll = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const applySelection = useCallback((drag, x, y, container) => {
    const cr = container.getBoundingClientRect();
    const rect = clipRect(marqueeRect(drag.startX, drag.startY, x, y), cr);
    if (rect.left >= rect.right || rect.top >= rect.bottom) return;
    const paths = [];
    for (const { path, element } of getItemsRef.current()) {
      if (element && rectsOverlap(rect, element.getBoundingClientRect())) paths.push(path);
    }
    if (drag.mode === 'add') {
      onReplaceRef.current([...drag.selectionAtStart, ...paths]);
    } else {
      onReplaceRef.current(paths);
    }
  }, []);

  const frame = useCallback(
    (drag, container) => {
      const cr = container.getBoundingClientRect();
      const x = drag.curX;
      let y = drag.curY + drag.scrollOffset;
      if (y < cr.top + SCROLL_EDGE) {
        const delta = Math.round((SCROLL_MAX * (cr.top + SCROLL_EDGE - y)) / SCROLL_EDGE);
        container.scrollTop += delta;
        drag.scrollOffset += delta;
      } else if (y > cr.bottom - SCROLL_EDGE) {
        const delta = Math.round((SCROLL_MAX * (y - (cr.bottom - SCROLL_EDGE))) / SCROLL_EDGE);
        container.scrollTop += delta;
        drag.scrollOffset += delta;
      }
      applySelection(drag, x, y, container);
      if (dragRef.current === drag) {
        rafRef.current = requestAnimationFrame(() => frame(drag, container));
      }
    },
    [applySelection]
  );

  const endDrag = useCallback(
    (drag, container) => {
      stopAutoScroll();
      if (dragRef.current === drag) dragRef.current = null;
      setStyle(null);
      try {
        container.releasePointerCapture(drag.pointerId);
      } catch {
        // уже отпущен
      }
    },
    [stopAutoScroll]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('[data-item]')) return;
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
        scrollOffset: 0,
        mode: e.ctrlKey || e.metaKey ? 'add' : 'replace',
        active: false,
        selectionAtStart: new Set(getSelectionRef.current ? getSelectionRef.current() : []),
      };
      try {
        container.setPointerCapture(e.pointerId);
      } catch {
        // захват недоступен
      }
      setStyle(null);
    };

    const onPointerMove = (e) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.curX = e.clientX;
      drag.curY = e.clientY;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < ACTIVATE_DIST) return;
        drag.active = true;
      }
      const cr = container.getBoundingClientRect();
      const left = Math.max(0, Math.min(drag.startX, drag.curX) - cr.left);
      const top = Math.max(0, Math.min(drag.startY, drag.curY) - cr.top);
      const right = Math.min(cr.width, Math.max(drag.startX, drag.curX) - cr.left);
      const bottom = Math.min(cr.height, Math.max(drag.startY, drag.curY) - cr.top);
      setStyle({
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      });
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => frame(drag, container));
      }
    };

    const onPointerUp = (e) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.active) onClearRef.current();
      endDrag(drag, container);
    };

    const onKeyDown = (e) => {
      const drag = dragRef.current;
      if (!drag || e.key !== 'Escape') return;
      if (drag.active) onReplaceRef.current([...drag.selectionAtStart]);
      endDrag(drag, container);
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      stopAutoScroll();
      dragRef.current = null;
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [containerRef, frame, endDrag, stopAutoScroll]);

  return style;
}
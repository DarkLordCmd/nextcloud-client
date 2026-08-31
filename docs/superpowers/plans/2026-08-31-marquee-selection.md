# Marquee (прямоугольное) выделение — план реализации

> **Для агентных исполнителей:** реализовывать по задачам через superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans. Шаги — `- [ ]`.

**Goal:** Добавить в `FileList` прямоугольное выделение (rubber band) как в Проводнике Windows.

**Architecture:** Новый хук `useMarquee` вешает `pointerdown/move/up` на scroll-контейнер списка, рисует оверлей-прямоугольник, хит-тест через `getBoundingClientRect()` и `closest('[data-item]')`, автопрокрутка через `requestAnimationFrame`. Модель выделения берётся из `AppContext` без изменений.

**Tech Stack:** React 18 (JSX), Tailwind. Без новых зависимостей.

## Global Constraints

- Без новых npm-зависимостей.
- Работа во всех режимах: `table`, `list`, `content`, `tiles`, `small`..`xlarge`.
- Папки выделяются как файлы; клик по папке продолжает открывать её; drag по элементу — прежний drag-out в ОС.
- Без модификатора — заменить выделение; Ctrl/Meta — добавить (union).
- Клик по пустому месту без движения — `clearSelection`.
- Escape отменяет активный marquee и возвращает выделение к состоянию на старте.
- Автопрокрутка при подводе к краю контейнера.
- В репозитории нет JS-тест-инфраструктуры: проверка — `npm run build:ui` + ручной чек-лист из спецификации.

---

### Task 1: Хук `useMarquee`

**Files:**
- Create: `src-ui/hooks/useMarquee.js`

**Interfaces:**
- Produces: `useMarquee({ containerRef, getItems, getSelection, onReplace, onClear }) -> style | null`
  - `containerRef`: `useRef` на scroll-контейнер (`.overflow-y-auto`).
  - `getItems()`: `() => Array<{ path, element }>` — элементы для хит-теста.
  - `getSelection()`: `() => Array<string>` — текущее выделение на момент старта драга.
  - `onReplace(paths)`: применить набор путей как выделение.
  - `onClear()`: сбросить выделение.
  - Возвращает объект стиля оверлея `{ left, top, width, height }` (px) или `null`.

- [ ] **Step 1: Создать файл хука**

```js
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
```

- [ ] **Step 2: Проверить, что файл создан и синтаксис корректен**

Run: `node --check src-ui/hooks/useMarquee.js`
Expected: без вывода (exit 0).

---

### Task 2: Подключить marquee в `FileList.jsx`

**Files:**
- Modify: `src-ui/components/FileList.jsx`

**Interfaces:**
- Consumes: `useMarquee` из Task 1; `replaceSelection`, `clearSelection` из `useApp`.

- [ ] **Step 1: Импорт и деструктуризация**

Добавить импорт после `import { previewKind } from '../previewTypes';`:

```js
import useMarquee from '../hooks/useMarquee';
```

В деструктуризации `useApp()` (строка ~46-60) добавить `clearSelection`:

```js
    selected,
    toggleSelect,
    replaceSelection,
    clearSelection,
```

Добавить реф scroll-контейнера рядом с `rootRef`:

```js
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
```

- [ ] **Step 2: Вызвать хук**

После `const sorted = useMemo(...)` (строка ~82-88) добавить вызов хука:

```js
  const marqueeStyle = useMarquee({
    containerRef: scrollRef,
    getItems: () => {
      const container = scrollRef.current;
      if (!container) return [];
      return Array.from(container.querySelectorAll('[data-item]')).map((el) => ({
        path: el.dataset.path,
        element: el,
      }));
    },
    getSelection: () => Array.from(selected),
    onReplace: replaceSelection,
    onClear: clearSelection,
  });
```

- [ ] **Step 3: Scroll-контейнер — ref, relative, select-none**

Строку ~309 заменить:

```jsx
      <div ref={scrollRef} className="relative min-h-0 flex-1 select-none overflow-y-auto">
```

- [ ] **Step 4: `data-item`/`data-path` на корнях элементов**

Во всех пяти ветках `renderItem` (table, list, content, grid) на корневой `div` добавить атрибуты `data-item` и `data-path={item.path}`. Пример (ветка table, строка ~210-218):

```jsx
        <div
          key={item.path}
          data-item
          data-path={item.path}
          draggable
          {...handlers}
```

Повторить для остальных веток (`list`, `content`, grid/tiles). `key={item.path}` сохраняется.

- [ ] **Step 5: Оверлей прямоугольника**

Внутрь scroll-контейнера, после блока items (после строки с `sorted.map(...)`), перед закрывающим `</div>` контейнера, добавить:

```jsx
        {marqueeStyle && (
          <div
            className="pointer-events-none absolute z-10 rounded-sm border border-nc-accent bg-nc-accent/20"
            style={marqueeStyle}
          />
        )}
```

- [ ] **Step 6: Сборка UI**

Run: `npm run build:ui`
Expected: `✓ built in ...` без ошибок.

---

### Task 3: Ручная проверка

**Files:** нет изменений.

- [ ] **Step 1: Проверить сценарии из спецификации**

Запуск: `npm run dev` (или готовый установщик). Чек-лист:
1. Таблица/список: марquee на пустом месте (ниже/выше строк) выделяет пересечённые строки; Ctrl+марquee добавляет; клик по пустому месту сбрасывает.
2. Сетки (small..xlarge, tiles): марquee по иконкам выделяет, включая частично пересечённые.
3. Автопрокрутка: драг к нижнему/верхнему краю длинного списка прокручивает и доселектовывает.
4. Escape: во время драга отменяет и возвращает прежнее выделение.
5. Драг на элементе — по-прежнему drag-out в ОС (не марquee).
6. Клик по папке — по-прежнему открывает папку; марquee по папкам выделяет их.
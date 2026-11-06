// dsh-1c-project-properties — клиентская половина.
//
// Вкладка «1С: Параметры проектов» в Settings: список проектов (воркспейсы DSH +
// добавленные вручную пути) и общие значения. Параметры конкретного проекта
// редактируются в отдельном модальном окне — в колонке настроек шириной ~520 px
// форма не помещается.
// Значения пишет хост-половина в файл .dsh/1c-project.json внутри папки проекта.
//
// Оформление: один инжектируемый <style> с классами p1c-* (он даёт hover/focus/
// disabled и скроллбар, чего инлайновые стили выразить не могут) + минимальные
// инлайновые стили только для раскладки. Никаких внешних зависимостей.
window.__ModuleLoader__.load({
  id: "dsh-1c-project-properties",
  factory: (require) => {
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { useState, useEffect, useCallback, useRef } = React;
    const ReactDOM = (() => {
      try {
        return require("react-dom");
      } catch {
        return null;
      }
    })();

    // Модальное окно выносим в document.body: панель настроек обрезает содержимое.
    const portal = (node) =>
      ReactDOM && typeof ReactDOM.createPortal === "function" && typeof document !== "undefined"
        ? ReactDOM.createPortal(node, document.body)
        : node;

    const API = "/1cprops";
    const PLATFORM_LIST_ID = "dsh-1cprops-platforms";
    const INFOBASE_LIST_ID = "dsh-1cprops-infobases";
    // Ссылка на набор по умолчанию: она же запасная для хоста, который ещё не
    // присылает rulesPayloads.list со ссылками на каждый набор.
    const RULES_REPO = "https://github.com/comol/ai_rules_1c";

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok === false) {
        const detail = (data && data.error) || response.statusText || "HTTP " + response.status;
        // 404 без тела — это «маршрут никто не зарегистрировал»: хост-часть плагина не
        // поднялась при старте DSH или упала на старте. Перезагрузка страницы тут не помогает,
        // и без объяснения это читается как «плагин сломан».
        if (response.status === 404 && data === null) {
          throw new Error(
            "Маршрут " + API + path + " не зарегистрирован (" + detail + "): хост-часть плагина не поднялась при старте DSH. " +
            "Перезапуск страницы не поможет — нужен перезапуск DSH. Если и он не помогает, в профиле осталась вторая копия " +
            "плагина или он упал при загрузке: причина в журнале DSH.",
          );
        }
        // Тело бывает не отказом: /rules-deploy отвечает ok:false вместе с
        // needsConfirmation и планом смены набора. Вызывающий успевает прочитать
        // error.data, прежде чем показать ошибку.
        const error = new Error(detail);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    }

    // Маршруты движка rlm живут под префиксом /rlm, а не в /1cprops.
    async function rlmRequest(path, init) {
      const response = await fetch("/rlm" + path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const type = response.headers.get("content-type") || "";
      if (!type.includes("application/json")) {
        const error = new Error("маршрут /rlm" + path + " не найден: движок rlm не загрузился");
        error.status = 0;
        throw error;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok === false) {
        const detail = (data && data.error) || response.statusText || "HTTP " + response.status;
        const error = new Error(detail);
        error.status = response.status;
        throw error;
      }
      return data;
    }

    // ── оформление ───────────────────────────────────────────────────────────

    const CSS = `
.p1c-root, .p1c-root * { box-sizing: border-box; }
.p1c-root {
  --p1c-border: var(--dsw-alias-border-l2, rgba(255,255,255,.14));
  --p1c-surface: var(--dsw-alias-bg-layer-2, #1f2026);
  --p1c-field-bg: var(--dsw-alias-bg-base, rgba(127,127,127,.08));
  --p1c-primary: var(--dsw-alias-state-business-primary, #3964fe);
  --p1c-danger: #e57373;
  --p1c-warn: #e0a030;
  --p1c-ok: #4caf50;
  /* Колонка с шагом: без неё блоки вкладки липнут друг к другу (у секции
     настроек нет собственного gap). */
  display: flex; flex-direction: column; gap: 14px; min-width: 0;
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  line-height: 1.45;
}
.p1c-root h1, .p1c-root h2, .p1c-root h3, .p1c-root p { margin: 0; font-size: inherit; font-weight: inherit; }
.p1c-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

.p1c-title { font-size: 15px; font-weight: 600; }
.p1c-subtitle { font-size: 12px; opacity: .62; margin-top: 4px; line-height: 1.5; }

.p1c-card { border: 1px solid var(--p1c-border); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.p1c-card__title { font-size: 13px; font-weight: 600; }
.p1c-card__hint { font-size: 11.5px; opacity: .6; margin-top: 4px; line-height: 1.5; }

.p1c-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.p1c-label-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.p1c-label { font-size: 12px; font-weight: 500; opacity: .78; }
.p1c-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
.p1c-span2 { grid-column: 1 / -1; }
@media (max-width: 640px) { .p1c-grid { grid-template-columns: 1fr; } }

.p1c-input, .p1c-select {
  width: 100%; min-width: 0; height: 32px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--p1c-border); background: var(--p1c-field-bg); color: inherit;
  /* Не шорткат font: с неразрешённой переменной он отбрасывается целиком, и
     контрол падает в шрифт UA — самый заметный симптом «чужого» селекта. */
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px; font-weight: 400; line-height: 1.45;
}
.p1c-select { padding-right: 6px; cursor: pointer; }
.p1c-field--format { max-width: 260px; }
.p1c-input::placeholder { color: inherit; opacity: .38; }
.p1c-input:focus, .p1c-select:focus {
  outline: none;
  border-color: var(--p1c-primary);
  box-shadow: 0 0 0 3px rgba(57,100,254,.3);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--p1c-primary) 30%, transparent);
}
.p1c-input:disabled, .p1c-select:disabled { opacity: .5; cursor: not-allowed; }

.p1c-options { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
.p1c-check-row { display: inline-flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.4; cursor: pointer; padding: 2px 0; }
.p1c-check-row--compact { font-size: 11px; opacity: .7; }
.p1c-check-row input { flex: 0 0 auto; width: 14px; height: 14px; margin: 1px 0 0; accent-color: var(--p1c-primary); cursor: pointer; }
.p1c-check { flex: 0 0 auto; width: 14px; height: 14px; margin: 0; accent-color: var(--p1c-primary); cursor: pointer; }
.p1c-check-row.is-disabled { opacity: .45; pointer-events: none; }

.p1c-btn {
  height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent;
  background: transparent; color: inherit; cursor: pointer; white-space: nowrap;
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px; font-weight: 500; line-height: 1.45;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  transition: background-color .12s ease, border-color .12s ease, filter .12s ease, opacity .12s ease;
}
/* Недоступная кнопка должна читаться: полупрозрачность ниже ~0.8 превращает
   подпись в серое пятно, поэтому гасим фон, а не текст. */
.p1c-btn:disabled { cursor: not-allowed; }
.p1c-btn--primary:disabled { background: rgba(57,100,254,.45); color: rgba(255,255,255,.9); }
.p1c-btn--primary:disabled { background: color-mix(in srgb, var(--p1c-primary) 45%, transparent); }
.p1c-btn--ghost:disabled { background: rgba(127,127,127,.1); border-color: var(--p1c-border); opacity: .9; }
.p1c-btn--danger:disabled { opacity: .8; }
.p1c-btn--primary { background: var(--p1c-primary); color: #fff; }
.p1c-btn--primary:not(:disabled):hover { filter: brightness(1.08); }
.p1c-btn--ghost { border-color: var(--p1c-border); }
.p1c-btn--ghost:not(:disabled):hover { background: rgba(127,127,127,.12); }
.p1c-btn--danger { color: var(--p1c-danger); }
.p1c-btn--danger:not(:disabled):hover { background: rgba(229,115,115,.12); border-color: rgba(229,115,115,.4); }
.p1c-btn--quiet { padding: 0 8px; opacity: .8; }
.p1c-btn--quiet:not(:disabled):hover { opacity: 1; background: rgba(127,127,127,.12); }
.p1c-btn--icon { width: 30px; height: 30px; padding: 0; }
.p1c-btn--icon:not(:disabled):hover { background: rgba(127,127,127,.14); }
.p1c-btn:focus-visible { outline: 2px solid var(--p1c-primary); outline-offset: 1px; }

.p1c-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* min-width: 0 обязателен: без него flex-элемент с полем ввода внутри
   раздувает строку и кнопка вылезает за границу карточки. */
.p1c-actions__grow { flex: 1 1 auto; min-width: 0; }

.p1c-project {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px;
  border: 1px solid transparent; border-radius: 10px; background: rgba(127,127,127,.06);
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.p1c-project:hover { border-color: var(--p1c-border); background: rgba(127,127,127,.1); }
.p1c-project:focus-visible { outline: 2px solid var(--p1c-primary); outline-offset: 1px; }
.p1c-project__main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.p1c-project__name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p1c-project__path { font-size: 11px; opacity: .5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p1c-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .45; }
.p1c-dot--ok { background: var(--p1c-ok); opacity: 1; }
.p1c-dot--warn { background: var(--p1c-warn); opacity: 1; }
.p1c-dot--err { background: var(--p1c-danger); opacity: 1; }
.p1c-strong { font-weight: 600; }
.p1c-sm { font-size: 12px; }
.p1c-text--ok { color: var(--p1c-ok); }
.p1c-text--warn { color: var(--p1c-warn); }
.p1c-text--err { color: var(--p1c-danger); }
.p1c-chevron { flex: 0 0 auto; opacity: .35; display: flex; }
.p1c-link { color: var(--p1c-primary); text-decoration: none; }
.p1c-link:hover { text-decoration: underline; }

.p1c-overlay { position: fixed; inset: 0; z-index: 2000; display: flex; align-items: center; justify-content: center; padding: 24px; }
.p1c-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.5)); }
.p1c-dialog {
  position: relative; z-index: 1; display: flex; flex-direction: column;
  width: 820px; max-width: 100%; max-height: 100%; overflow: hidden;
  border: 1px solid var(--p1c-border); border-radius: 18px;
  background: var(--p1c-surface); color: var(--dsw-alias-label-primary, inherit);
  box-shadow: var(--dsw-elevation-prominent, 0 18px 48px rgba(0,0,0,.5));
}
.p1c-dialog__head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 18px 14px; border-bottom: 1px solid var(--p1c-border); }
.p1c-dialog__headmain { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.p1c-dialog__title { font-size: 15px; font-weight: 600; }
.p1c-dialog__project { font-size: 13px; font-weight: 600; }
.p1c-dialog__path { font-size: 11.5px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p1c-dialog__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.p1c-dialog__body::-webkit-scrollbar { width: 10px; }
.p1c-dialog__body::-webkit-scrollbar-thumb { background: rgba(127,127,127,.3); border: 3px solid transparent; border-radius: 8px; background-clip: content-box; }
.p1c-dialog__foot { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--p1c-border); }
.p1c-dialog__footleft { display: flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 0; }
.p1c-dialog__footright { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
/* Окно правил: три колонки фиксированной высоты, прокручиваются списки, а не
   всё окно. Иначе описание правила уезжает за форму, а категории ломаются. */
.p1c-bsl-rules { display: grid; grid-template-columns: 240px minmax(0, 1fr) 300px; gap: 12px; height: min(56vh, 520px); min-height: 320px; overflow: hidden; }
.p1c-bsl-rules__col { display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; }
.p1c-bsl-rules__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 4px; }
.p1c-bsl-rules__scroll::-webkit-scrollbar { width: 8px; }
.p1c-bsl-rules__scroll::-webkit-scrollbar-thumb { background: rgba(127,127,127,.28); border-radius: 8px; }
.p1c-bsl-rules__row { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 6px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.p1c-bsl-rules__row:hover { background: rgba(127,127,127,.09); }
.p1c-bsl-rules__row.is-active { background: rgba(80,120,255,.16); }
.p1c-bsl-rules__row.is-muted .p1c-bsl-rules__name { opacity: .5; }
.p1c-bsl-rules__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p1c-bsl-rules__count { flex: 0 0 auto; font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; }
.p1c-bsl-rules__sev { flex: 0 0 auto; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; opacity: .7; }
.p1c-bsl-rules__title { font-size: 13px; font-weight: 600; line-height: 1.4; }
.p1c-bsl-rules__meta { font-size: 11px; opacity: .6; }
.p1c-bsl-rules__desc { font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.p1c-bsl-rules__empty { font-size: 11.5px; opacity: .6; padding: 6px 2px; }

.p1c-details { border-top: 1px dashed var(--p1c-border); padding-top: 10px; }
.p1c-details > summary { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; opacity: .75; cursor: pointer; list-style: none; }
.p1c-details > summary::-webkit-details-marker { display: none; }
.p1c-details > summary:hover { opacity: 1; }
.p1c-details__chev { display: flex; transition: transform .15s ease; }
.p1c-details[open] > summary .p1c-details__chev { transform: rotate(90deg); }
.p1c-details__body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }

.p1c-status { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.5; }
.p1c-status__dot { flex: 0 0 auto; margin-top: 6px; }
.p1c-log {
  margin: 0; max-height: 240px; overflow: auto; padding: 10px 12px; border-radius: 8px;
  background: rgba(0,0,0,.28); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
}
.p1c-note { font-size: 11.5px; line-height: 1.5; opacity: .62; }
.p1c-note--warn { color: var(--p1c-warn); opacity: 1; }
.p1c-note--err { color: var(--p1c-danger); opacity: 1; }
.p1c-note--ok { color: var(--p1c-ok); opacity: 1; }
/* Состояние операции — отдельным боксом: в общем содержимом карточки оно
   сливалось с подписями и читалось как одна строка. */
.p1c-job {
  border: 1px solid var(--p1c-border); border-radius: 10px;
  background: rgba(127,127,127,.07); padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.p1c-job__head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.p1c-job__state { font-size: 12.5px; font-weight: 600; }
.p1c-job__op { font-size: 11.5px; opacity: .62; }
.p1c-job__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 3px 14px; font-size: 12px; }
.p1c-job__key { opacity: .55; }
.p1c-job__dir { font-size: 11.5px; opacity: .62; word-break: break-all; }
.p1c-stack { display: flex; flex-direction: column; gap: 14px; }
.p1c-stack--tight { gap: 6px; }
.p1c-overlay { pointer-events: auto; }
.p1c-rows { display: flex; flex-direction: column; gap: 8px; }
.p1c-row { display: flex; align-items: baseline; gap: 12px; font-size: 12.5px; }
.p1c-row__key { flex: 0 0 auto; min-width: 96px; opacity: .62; }
.p1c-row__value { flex: 1 1 auto; min-width: 0; font-weight: 500; word-break: break-word; }

/* Замечание в панели: позиция слева, текст справа. Без этого строки
   слипались в один абзац и панель было невозможно читать. */
.p1c-path { overflow-wrap: anywhere; word-break: break-word; opacity: .75; }
/* Замечание в узкой панели: строка метаданных сверху, текст на всю ширину.
   Раскладка «позиция слева, текст справа» съедала текст в колонку в 15 символов. */
.p1c-finding { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; margin: 0 -8px; border-radius: 8px; }
.p1c-finding:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.p1c-finding--skipped { opacity: .45; }
.p1c-finding__head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.p1c-finding__pos { flex: 0 0 auto; font-size: 11px; opacity: .55; }
.p1c-finding__code { font-size: 10.5px; opacity: .45; margin-top: -2px; overflow-wrap: anywhere; }
.p1c-finding__msg { font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
.p1c-actions > .p1c-input { flex: 1 1 0; width: auto; min-width: 0; }

/* Важность: тот же язык, что в окне правил — цвет читается быстрее слова. */
.p1c-sev { font-size: 10.5px; line-height: 1.6; padding: 0 6px; border-radius: 5px; letter-spacing: .02em; text-transform: lowercase; }
.p1c-sev--blocker, .p1c-sev--critical, .p1c-sev--error { color: var(--p1c-danger); background: rgba(229,115,115,.14); }
.p1c-sev--major, .p1c-sev--warning { color: var(--p1c-warn); background: rgba(224,160,48,.16); }
.p1c-sev--minor { color: var(--dsw-alias-label-secondary, #a6acb8); background: rgba(127,127,127,.14); }
.p1c-sev--info, .p1c-sev--hint { color: var(--dsw-alias-label-tertiary, #8a909b); background: rgba(127,127,127,.1); }

.p1c-finding__acts { display: inline-flex; align-items: center; gap: 10px; margin-left: auto; flex: 0 0 auto; white-space: nowrap; }
.p1c-finding__skip {
  flex: 0 0 auto; border: 0; background: none; padding: 0; cursor: pointer;
  color: var(--dsw-alias-label-secondary, inherit); font: inherit; font-size: 11px; line-height: 1.6;
  border-radius: 4px;
}
.p1c-finding__skip:hover { color: var(--dsw-alias-label-primary, inherit); text-decoration: underline; }

/* Панель сайдбара: карточки на своей подложке, иначе блоки сливаются с фоном
   и выглядят как непрогруженные. */
/* Подтверждение действия поверх окна: тёмная поверхность в обеих темах,
   как у тостов DSH. Кликов не перехватывает. */
.p1c-toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  z-index: 2147483000; display: flex; justify-content: center;
  max-width: min(640px, calc(100vw - 48px)); pointer-events: none;
}
.p1c-toast__pill {
  display: inline-flex; align-items: center; padding: 12px 16px;
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-toast-bg, #353638);
  color: var(--dsw-alias-toast-label, #fff);
  font-family: var(--dsw-font-family, inherit); font-size: 14px; line-height: 22px;
  box-shadow: var(--dsw-shadow-lv3, 0 0 1px rgba(0,0,0,.2), 0 12px 32px rgba(0,0,0,.16));
  animation: p1c-toast-in .16s ease-out;
}
.p1c-toast--leaving .p1c-toast__pill { animation: p1c-toast-out .2s ease-in forwards; }
@keyframes p1c-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes p1c-toast-out { to { opacity: 0; transform: translateY(4px); } }

/* Панель прокручивается сама и берёт поверхность родного сайдбара DSH:
   иначе она читается как чужой островок рядом с его деревом. */
.p1c-root--panel {
  gap: 6px; height: 100%; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  background: var(--dsw-alias-bg-layer-1, transparent);
}

/* Шапка: время проверки слева, пропущенные — ссылкой справа. */
.p1c-panelhead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 2px 0 2px; }
.p1c-panelhead__meta {
  min-width: 0; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, inherit);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.p1c-linkbtn {
  border: 0; background: none; padding: 0; cursor: pointer; font: inherit; font-size: 11.5px;
  color: var(--dsw-alias-state-business-primary, var(--p1c-primary)); border-radius: 4px;
}
.p1c-linkbtn { flex: 0 0 auto; white-space: nowrap; }
.p1c-linkbtn:hover { text-decoration: underline; }

/* Список — плоский, как дерево файлов в сайдбаре: разделитель волоском,
   никаких рамок и подложек. */

/* Заголовок модуля — кнопка: сворачивает замечания. */
.p1c-filehead {
  display: flex; align-items: flex-start; gap: 6px; width: 100%; padding: 2px 0;
  border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
  border-radius: 6px;
}
.p1c-filehead:hover { color: var(--dsw-alias-label-primary, inherit); }
.p1c-filehead:focus-visible { outline: 2px solid var(--p1c-primary); outline-offset: 2px; }
.p1c-chevron { flex: 0 0 auto; margin-top: 3px; color: var(--dsw-alias-label-secondary, inherit); transition: transform .15s ease; }
.p1c-chevron--folded { transform: rotate(-90deg); }
.p1c-filehead .p1c-path {
  flex: 1 1 auto; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}
.p1c-filehead__count { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, currentColor); }
.p1c-root--panel .p1c-card {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.07));
  border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.2));
  border-radius: 10px; padding: 10px 12px; gap: 8px;
}
/* Строка набора: имя и подпись слева, действия справа; на узком экране
   действия уходят на свою строку. */
.p1c-preset { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 0; border-top: 1px solid var(--p1c-border); }
.p1c-preset:first-child { border-top: 0; padding-top: 0; }
.p1c-preset__acts { display: flex; gap: 8px; margin-left: auto; }
.p1c-preset .p1c-row__key, .p1c-preset .p1c-input { min-width: 0; }

.p1c-root--panel .p1c-btn { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 7px; }
.p1c-root--panel .p1c-btn--ghost { border-color: var(--dsw-alias-hairline, var(--p1c-border)); }
.p1c-root--panel .p1c-btn--ghost:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.p1c-root--panel .p1c-input { height: 30px; }
.p1c-root--panel .p1c-note { color: var(--dsw-alias-label-tertiary, inherit); opacity: 1; }
.p1c-root--panel .p1c-card__hint { opacity: 1; color: var(--dsw-alias-label-tertiary, inherit); }
/* Шаги визарда: серая полоса на весь путь, текущий шаг — зелёным свечением. */
/* Окно визарда одной высоты на всех шагах: страницы не раскачивают его размер.
   Считано по самой большой странице — «База и платформа». */
.p1c-dialog__body--wizard { height: 480px; max-height: calc(100vh - 226px); overflow-y: auto; scrollbar-gutter: stable; }
/* Окно проекта тоже одной высоты: карточки внутри меняются (набор правил,
   параметры, результат операции), а размер окна прыгать не должен. */
.p1c-dialog__body--project { height: min(640px, calc(100vh - 200px)); scrollbar-gutter: stable; }
.p1c-check-line--status { font-size: 12px; align-items: center; min-height: 18px; }
.p1c-card .p1c-details { margin-top: 2px; }
.p1c-details .p1c-grid { margin-top: 8px; }
.p1c-steps { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 4px; }
.p1c-step { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.p1c-step__bar { height: 3px; border-radius: 2px; background: rgba(127,127,127,.26); transition: background-color .18s ease, box-shadow .18s ease; }
.p1c-step__label { font-size: 10.5px; line-height: 1.3; opacity: .42; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p1c-step.is-done .p1c-step__bar { background: var(--p1c-ok); }
.p1c-step.is-current .p1c-step__bar { background: var(--p1c-ok); box-shadow: 0 0 10px 2px rgba(76,175,80,.55); box-shadow: 0 0 10px 2px color-mix(in srgb, var(--p1c-ok) 55%, transparent); }
.p1c-step.is-current .p1c-step__label { opacity: .9; }
.p1c-check-line { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.p1c-check-line .p1c-dot { margin-top: 0; }

/* Выбор набора правил: радио и ровно одна строка подсказки под каждым вариантом.
   Переносить подсказку на вторую строку нельзя — страницы визарда и карточки
   держат одну высоту, длинный текст показывает title. */
.p1c-radios { display: flex; flex-direction: column; gap: 6px; }
.p1c-radio { display: flex; align-items: flex-start; gap: 8px; width: 100%; }
/* Обёртка подписи — flex-элемент радио: без min-width: 0 длинная подсказка
   не обрезается, а растягивает строку. */
.p1c-radio > span { flex: 1 1 auto; min-width: 0; }
.p1c-radio__main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.p1c-radio__title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12.5px; line-height: 1.4; }
.p1c-radio__hint { font-size: 11px; line-height: 1.4; opacity: .58; }
.p1c-radio__badge {
  flex: 0 0 auto; font-size: 10.5px; line-height: 1.6; padding: 0 6px; border-radius: 999px;
  border: 1px solid var(--p1c-border); opacity: .7; white-space: nowrap;
}
/* Подтверждение смены набора — узкое окно поверх окна проекта. */
.p1c-dialog--confirm { width: 520px; }
.p1c-plan {
  max-height: 150px; overflow: auto; padding: 8px 10px; border-radius: 8px;
  background: rgba(127,127,127,.08); display: flex; flex-direction: column; gap: 1px;
}
.p1c-plan__line { font-size: 11px; line-height: 1.45; opacity: .8; word-break: break-all; }
`;

    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected) return;
      if (typeof document === "undefined" || !document.head) return;
      const tag = document.createElement("style");
      tag.textContent = CSS;
      document.head.appendChild(tag);
      stylesInjected = true;
    }

    // ── мелкие строительные блоки ────────────────────────────────────────────

    const cx = (...parts) => parts.filter(Boolean).join(" ");

    // «4 замечания», а не «4 замечаний»: число видно в панели постоянно.
    function plural(count, forms) {
      const value = Math.abs(Number(count) || 0);
      const tail = value % 100;
      if (tail >= 11 && tail <= 14) return forms[2];
      const last = value % 10;
      if (last === 1) return forms[0];
      if (last >= 2 && last <= 4) return forms[1];
      return forms[2];
    }

    // ── проверки кода (bsl-analyzer) ─────────────────────────────────────────
    // Карточка живёт в параметрах проекта и в визарде, окно правил — поверх них.
    // Проверку запускает агент; здесь только включение, набор и правка набора.
    const CHECKS = "/bsl-checks";

    // В параметрах проекта — только включение и выбор набора: там пользователь
    // решает про проект, а не про правила. Движок, наборы и правка правил живут
    // на отдельной вкладке настроек «1С: Анализ кода».
    function ChecksCard(props) {
      const projectPath = props.path;
      const [state, setState] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      injectStyles();

      const load = useCallback(async () => {
        const data = await request(CHECKS + "/state?project=" + encodeURIComponent(projectPath));
        setState(data);
        setError("");
        return data;
      }, [projectPath]);

      useEffect(() => {
        let alive = true;
        load().catch((cause) => {
          if (alive) setError(cause.message);
        });
        return () => {
          alive = false;
        };
      }, [load]);

      const toggle = async () => {
        setBusy(true);
        try {
          const data = await request(CHECKS + "/toggle", {
            method: "POST",
            body: JSON.stringify({ project: projectPath, enabled: !(state && state.enabled) }),
          });
          setState(data);
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      };

      const selectPreset = async (event) => {
        setBusy(true);
        try {
          const data = await request(CHECKS + "/preset", {
            method: "POST",
            body: JSON.stringify({ project: projectPath, action: "select", presetId: event.target.value }),
          });
          setState(data);
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      };

      if (!state) {
        return jsx(Card, {
          title: "Статический анализ кода",
          children: jsx("div", { className: "p1c-note", children: error || "читаю настройки…" }),
        });
      }

      const presets = state.presets || [];
      const total = state.catalog ? state.catalog.total : 0;

      return jsxs(Card, {
        title: "Статический анализ кода",
        children: [
          jsxs("div", {
            className: "p1c-row",
            children: [
              jsx("span", { className: "p1c-row__key", children: "Включить анализ кода" }),
              jsx("input", {
                type: "checkbox",
                className: "p1c-check",
                checked: state.enabled,
                disabled: busy,
                onChange: toggle,
              }),
            ],
          }),
          jsxs("div", {
            className: "p1c-row",
            children: [
              jsx("span", { className: "p1c-row__key", children: "Набор правил" }),
              jsx("span", {
                className: "p1c-row__value",
                children: jsx("select", {
                  className: "p1c-select",
                  value: state.presetId,
                  disabled: busy || !state.enabled,
                  onChange: selectPreset,
                  children: presets.map((preset) =>
                    jsx("option", {
                      value: preset.id,
                      children: preset.name + " · " + preset.enabled + " из " + total,
                    }),
                  ),
                }),
              }),
            ],
          }),
          state.presetFallback
            ? jsx("div", {
                className: "p1c-note p1c-note--warn",
                children:
                  "Набор, выбранный раньше, не найден: используется «" + state.presetName + "». Свой набор можно выбрать здесь же.",
              })
            : null,
          error ? jsx("div", { className: "p1c-note p1c-note--warn", children: error }) : null,
        ],
      });
    }

    // Вкладка настроек: анализатор и наборы правил. Проектов здесь нет —
    // в проекте выбирают набор, а правила, копии и движок живут тут.
    function ChecksSection() {
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const [rulesFor, setRulesFor] = useState("");
      const [renaming, setRenaming] = useState("");
      const [renameDraft, setRenameDraft] = useState("");
      const [deleting, setDeleting] = useState("");
      const [newName, setNewName] = useState("");
      const [newBase, setNewBase] = useState("");
      const [naparnik, setNaparnik] = useState(null);
      const [budget, setBudget] = useState(null);
      const [budgetBusy, setBudgetBusy] = useState(false);
      const [token, setToken] = useState("");
      const [tokenSaving, setTokenSaving] = useState(false);
      const [tokenNote, setTokenNote] = useState("");
      injectStyles();

      const load = useCallback(async () => {
        const [payload, naparnikPayload, budgetPayload] = await Promise.all([
          request(CHECKS + "/presets"),
          request(CHECKS + "/naparnik").catch(() => null),
          request(CHECKS + "/naparnik-budget").catch(() => null),
        ]);
        setData(payload);
        setNewBase((current) => current || ((payload.presets && payload.presets[0] && payload.presets[0].id) || ""));
        setNaparnik(naparnikPayload);
        setBudget(budgetPayload ? budgetPayload.budget : null);
        setError("");
        return payload;
      }, []);

      useEffect(() => {
        load().catch((cause) => setError(cause.message));
      }, [load]);

      // Наборы живут на машине: правки не привязаны к проекту.
      const act = async (payload) => {
        setBusy(true);
        try {
          const next = await request(CHECKS + "/preset", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          setData(next);
          setError("");
          return next;
        } catch (cause) {
          setError(cause.message);
          return null;
        } finally {
          setBusy(false);
        }
      };

      const download = async () => {
        setBusy(true);
        try {
          await request(CHECKS + "/engine", { method: "POST", body: JSON.stringify({ download: true }) });
          await load();
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      };

      // Токен Напарника — единственное значение вкладки, которое пользователь
      // вводит руками. Хранится в общих настройках плагина, не в проекте.
      // Квота ключа: та же, что жжёт веб-морда Напарника, поэтому смотрим перед пачкой ревью.
      const refreshBudget = async () => {
        setBudgetBusy(true);
        try {
          const payload = await request(CHECKS + "/naparnik-budget");
          setBudget(payload.budget);
        } catch (cause) {
          setBudget({ ok: false, error: cause.message });
        } finally {
          setBudgetBusy(false);
        }
      };

      const saveToken = async () => {
        setTokenSaving(true);
        setTokenNote("");
        try {
          const result = await request(CHECKS + "/naparnik", {
            method: "POST",
            body: JSON.stringify({ token }),
          });
          setNaparnik(result);
          setToken("");
          setTokenNote(
            result.registered
              ? "Токен сохранён, сервер подключён: агент видит " + result.server + "."
              : "Токен сохранён, сервер не подключён: " + (result.error || "причина неизвестна"),
          );
        } catch (cause) {
          setTokenNote(cause.message);
        } finally {
          setTokenSaving(false);
        }
      };

      if (!data) {
        return jsxs("div", {
          className: "p1c-root p1c-stack",
          children: [
            jsx("div", { className: "p1c-title", children: "1С: Анализ кода" }),
            jsx("div", { className: "p1c-note", children: error || "читаю настройки…" }),
          ],
        });
      }

      const engine = data.engine || {};
      const engineReady = Boolean(engine.downloaded);
      const total = data.catalog ? data.catalog.total : 0;
      const presets = data.presets || [];
      const budgetText = (() => {
        if (!budget) return "не проверялся";
        if (budget.ok !== true) return budget.error || "нет данных";
        const share = (window) => (window ? window.percent + " %" : "окно не активно");
        const reset = budget.weekly && budget.weekly.resetsAt
          ? " · сброс недели " +
            new Date(budget.weekly.resetsAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
          : "";
        return "5 ч: " + share(budget.sliding5h) + " · неделя: " + share(budget.weekly) + reset;
      })();
      const naparnikStateText = !naparnik
        ? "читаю…"
        : naparnik.registered
          ? "подключён как " + naparnik.server
          : !naparnik.engine || !naparnik.engine.downloaded
            ? "ждёт движок bsl-analyzer"
            : !naparnik.tokenSet
              ? "ждёт токен"
              : naparnik.error || "не подключён";

      return jsxs("div", {
        className: "p1c-root p1c-stack",
        children: [
          jsxs("div", {
            children: [
              jsx("div", { className: "p1c-title", children: "1С: Анализ кода" }),
              jsx("div", {
                className: "p1c-subtitle",
                children: "Проверки статическим анализатором bsl-analyzer. Набор правил проект выбирает сам, наборы общие для машины.",
              }),
            ],
          }),
          jsxs("div", {
            className: "p1c-card",
            children: [
              jsx("div", { className: "p1c-card__title", children: "bsl-analyzer" }),
              jsxs("div", {
                className: "p1c-row",
                children: [
                  jsx("span", { className: "p1c-row__key", children: "Состояние" }),
                  jsx("span", {
                    className: "p1c-row__value p1c-sm",
                    children: engineReady
                      ? "установлен" + (engine.sizeMb ? " · " + engine.sizeMb + " МБ" : "")
                      : engine.supported
                        ? "не скачан"
                        : "для этой платформы сборка не закреплена",
                  }),
                ],
              }),
              engineReady && engine.path ? jsx("div", { className: "p1c-note p1c-mono p1c-sm", children: engine.path }) : null,
              jsxs("div", {
                className: "p1c-actions",
                children: [
                  jsx(Btn, {
                    variant: engineReady ? undefined : "primary",
                    disabled: busy || !engine.supported,
                    onClick: download,
                    children: engineReady ? "Проверить установку" : "Скачать bsl-analyzer",
                  }),
                  jsx("span", {
                    className: "p1c-note",
                    children: "Один раз, около 76 МБ. Дальше проверки идут без интернета.",
                  }),
                ],
              }),
            ],
          }),
          jsxs("div", {
            className: "p1c-card",
            children: [
              jsx("div", { className: "p1c-card__title", children: "1С:Напарник" }),
              jsx("div", {
                className: "p1c-note",
                children:
                  "Ответы по стандартам разработки ИТС, БСП и методическим материалам словами. Агент спрашивает их инструментом its_help; справка по API платформы и поиск по документации — у других серверов.",
              }),
              jsxs("div", {
                className: "p1c-row",
                children: [
                  jsx("span", { className: "p1c-row__key", children: "Токен" }),
                  jsx("span", {
                    className: "p1c-row__value",
                    children: jsx("input", {
                      className: "p1c-input",
                      type: "text",
                      spellCheck: false,
                      autoComplete: "off",
                      placeholder:
                        naparnik && naparnik.tokenSet
                          ? "задан, оканчивается на " + naparnik.tokenTail
                          : "вставьте токен с code.1c.ai/tokens",
                      value: token,
                      disabled: tokenSaving,
                      onChange: (event) => setToken(event.target.value),
                    }),
                  }),
                ],
              }),
              jsxs("div", {
                className: "p1c-row",
                children: [
                  jsx("span", { className: "p1c-row__key", children: "MCP-сервер" }),
                  jsx("span", { className: "p1c-row__value p1c-sm", children: naparnikStateText }),
                ],
              }),
              jsxs("div", {
                className: "p1c-row",
                children: [
                  jsx("span", { className: "p1c-row__key", children: "Бюджет" }),
                  jsx("span", {
                    className: "p1c-row__value p1c-sm",
                    style: { display: "flex", gap: "10px", alignItems: "center", justifyContent: "flex-end" },
                    children: [
                      jsx("span", { className: "p1c-note p1c-sm", children: budgetText }),
                      jsx(Btn, {
                        variant: "quiet",
                        disabled: budgetBusy || !(naparnik && naparnik.tokenSet),
                        onClick: refreshBudget,
                        children: budgetBusy ? "спрашиваю…" : "Проверить",
                      }),
                    ],
                  }),
                ],
              }),
              jsxs("div", {
                className: "p1c-actions",
                children: [
                  jsx(Btn, {
                    variant: "primary",
                    disabled: tokenSaving || !token.trim(),
                    onClick: saveToken,
                    children: "Сохранить",
                  }),
                  jsx("span", {
                    className: "p1c-note p1c-sm",
                    children: "Токен хранится в общих настройках плагина, не в проекте.",
                  }),
                ],
              }),
              tokenNote ? jsx("div", { className: "p1c-note p1c-sm", children: tokenNote }) : null,
            ],
          }),
          jsxs("div", {
            className: "p1c-card",
            children: [
              jsx("div", { className: "p1c-card__title", children: "Наборы правил" }),
              jsx("div", {
                className: "p1c-stack p1c-stack--tight",
                children: presets.map((preset) => {
                  const isRenaming = renaming === preset.id;
                  const isDeleting = deleting === preset.id;
                  return jsxs(
                    "div",
                    {
                      key: preset.id,
                      className: "p1c-preset",
                      children: [
                        isRenaming
                          ? jsx("input", {
                              className: "p1c-input",
                              style: { maxWidth: "260px" },
                              value: renameDraft,
                              autoFocus: true,
                              onChange: (event) => setRenameDraft(event.target.value),
                              onKeyDown: (event) => {
                                if (event.key !== "Enter") return;
                                act({ action: "rename", presetId: preset.id, name: renameDraft }).then((next) => {
                                  if (next) setRenaming("");
                                });
                              },
                            })
                          : jsx("span", { className: "p1c-row__key", children: preset.name }),
                        jsx("span", {
                          className: "p1c-note p1c-sm",
                          children:
                            (preset.builtin ? "поставка" : "мой") +
                            " · " +
                            preset.enabled +
                            " из " +
                            total +
                            " · " +
                            preset.threshold,
                        }),
                        jsxs("span", {
                          className: "p1c-preset__acts",
                          children: [
                            jsx(Btn, { variant: "quiet", disabled: busy, onClick: () => setRulesFor(preset.id), children: "Правила" }),
                            preset.builtin
                              ? null
                              : jsx(Btn, {
                                  disabled: busy,
                                  onClick: () => {
                                    setRenaming(preset.id);
                                    setRenameDraft(preset.name);
                                    setDeleting("");
                                  },
                                  children: "Переименовать",
                                }),
                            preset.builtin
                              ? null
                              : jsx(Btn, {
                                  variant: "danger",
                                  disabled: busy,
                                  onClick: () => {
                                    setDeleting(preset.id);
                                    setRenaming("");
                                  },
                                  children: "Удалить",
                                }),
                          ],
                        }),
                        isDeleting
                          ? jsxs("div", {
                              className: "p1c-actions",
                              children: [
                                jsx("span", {
                                  className: "p1c-note p1c-sm",
                                  children: "Проекты, где он выбран, вернутся к поставке.",
                                }),
                                jsx(Btn, {
                                  variant: "danger",
                                  disabled: busy,
                                  onClick: () =>
                                    act({ action: "delete", presetId: preset.id }).then((next) => {
                                      if (next) setDeleting("");
                                    }),
                                  children: "Удалить",
                                }),
                                jsx(Btn, { onClick: () => setDeleting(""), children: "Отмена" }),
                              ],
                            })
                          : null,
                      ],
                    },
                  );
                }),
              }),
              jsxs("div", {
                className: "p1c-actions",
                children: [
                  jsx("select", {
                    className: "p1c-select",
                    style: { flex: "0 1 220px", width: "auto", maxWidth: "260px" },
                    value: newBase,
                    disabled: busy,
                    onChange: (event) => setNewBase(event.target.value),
                    children: presets.map((preset) => jsx("option", { value: preset.id, children: "копия: " + preset.name })),
                  }),
                  jsx("input", {
                    className: "p1c-input",
                    style: { flex: "1 1 160px", minWidth: 0 },
                    placeholder: "Название набора",
                    value: newName,
                    onChange: (event) => setNewName(event.target.value),
                  }),
                  jsx(Btn, {
                    variant: "primary",
                    disabled: busy || !newName.trim() || !newBase,
                    onClick: () =>
                      act({ action: "create", base: newBase, name: newName }).then((next) => {
                        if (next) setNewName("");
                      }),
                    children: "Создать",
                  }),
                ],
              }),
              jsx("div", {
                className: "p1c-note p1c-sm",
                children: "Наборы поставки неизменяемы: правка создаёт ваш набор. Набор общий для машины.",
              }),
            ],
          }),
          error ? jsx("div", { className: "p1c-note p1c-note--warn", children: error }) : null,
          rulesFor
            ? jsx(ChecksRulesDialog, {
                presetId: rulesFor,
                onClose: () => setRulesFor(""),
                onApplied: () => load().catch(() => {}),
              })
            : null,
        ],
      });
    }

    function ChecksRulesDialog(props) {
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const [query, setQuery] = useState("");
      const [category, setCategory] = useState("Все правила");
      const [selected, setSelected] = useState("");
      const [on, setOn] = useState(new Set());
      const [saving, setSaving] = useState(false);

      useEffect(() => {
        let alive = true;
        const query = props.presetId
          ? "presetId=" + encodeURIComponent(props.presetId)
          : "project=" + encodeURIComponent(props.path);
        request(CHECKS + "/rules?" + query)
          .then((payload) => {
            if (!alive) return;
            setData(payload);
            setOn(new Set(payload.rules.filter((rule) => rule.on).map((rule) => rule.code)));
            setSelected(payload.rules.length ? payload.rules[0].code : "");
          })
          .catch((cause) => {
            if (alive) setError(cause.message);
          });
        return () => {
          alive = false;
        };
      }, [props.path, props.presetId]);

      const rules = (data && data.rules) || [];
      const categories = ["Все правила", ...Array.from(new Set(rules.map((rule) => rule.category)))];
      const needle = query.trim().toLowerCase();
      const visible = rules.filter(
        (rule) =>
          (category === "Все правила" || rule.category === category) &&
          (!needle ||
            rule.code.toLowerCase().includes(needle) ||
            rule.name.toLowerCase().includes(needle) ||
            (rule.description || "").toLowerCase().includes(needle)),
      );
      const current = rules.find((rule) => rule.code === selected) || null;

      const toggleRule = (code) => {
        const next = new Set(on);
        if (next.has(code)) next.delete(code);
        else next.add(code);
        setOn(next);
      };

      const apply = async () => {
        setSaving(true);
        try {
          const off = rules.filter((rule) => !on.has(rule.code)).map((rule) => rule.code);
          const result = await request(CHECKS + "/preset", {
            method: "POST",
            body: JSON.stringify({
              project: props.path || undefined,
              presetId: data.presetId,
              off,
              threshold: data.threshold,
            }),
          });
          if (props.onApplied) props.onApplied(result);
          props.onClose();
        } catch (cause) {
          setError(cause.message);
        } finally {
          setSaving(false);
        }
      };

      const head = jsxs("div", {
        className: "p1c-dialog__head",
        children: [
          jsxs("div", {
            className: "p1c-dialog__headmain",
            children: [
              jsx("div", { className: "p1c-dialog__title", children: "Правила статического анализа" }),
              jsx("div", { className: "p1c-dialog__path", children: data ? data.presetName : "читаю каталог…" }),
            ],
          }),
          jsx(Btn, { onClick: props.onClose, children: "Закрыть" }),
        ],
      });

      const severityTone = (value) => {
        const text = String(value || "").toLowerCase();
        if (text === "blocker" || text === "critical") return "p1c-text--err";
        if (text === "major") return "p1c-text--warn";
        return "";
      };

      const body = !data
        ? jsx("div", { className: "p1c-dialog__body", children: jsx("div", { className: "p1c-note", children: error || "читаю каталог правил…" }) })
        : jsxs("div", {
            className: "p1c-dialog__body p1c-bsl-rules",
            children: [
              jsxs("div", {
                className: "p1c-bsl-rules__col",
                children: [
                  jsx("div", { key: "head", className: "p1c-bsl-rules__meta", children: "Категории" }),
                  jsx("div", {
                    key: "list",
                    className: "p1c-bsl-rules__scroll",
                    children: categories.map((name) => {
                      const list = name === "Все правила" ? rules : rules.filter((rule) => rule.category === name);
                      const enabled = list.filter((rule) => on.has(rule.code)).length;
                      return jsxs(
                        "div",
                        {
                          key: name,
                          className: cx("p1c-bsl-rules__row", category === name && "is-active"),
                          title: name,
                          onClick: () => setCategory(name),
                          children: [
                            jsx("span", { className: "p1c-bsl-rules__name", children: name }),
                            jsx("span", { className: "p1c-bsl-rules__count", children: enabled + "/" + list.length }),
                          ],
                        },
                      );
                    }),
                  }),
                ],
              }),
              jsxs("div", {
                className: "p1c-bsl-rules__col",
                children: [
                  jsx("input", {
                    key: "search",
                    className: "p1c-input",
                    placeholder: "Поиск по названию, коду или описанию",
                    value: query,
                    onChange: (event) => setQuery(event.target.value),
                  }),
                  jsx("div", {
                    key: "list",
                    className: "p1c-bsl-rules__scroll",
                    children: visible.length
                      ? visible.map((rule) =>
                          jsxs(
                            "div",
                            {
                              key: rule.code,
                              className: cx(
                                "p1c-bsl-rules__row",
                                rule.code === selected && "is-active",
                                !on.has(rule.code) && "is-muted",
                              ),
                              title: rule.name,
                              onClick: () => setSelected(rule.code),
                              children: [
                                jsx("input", {
                                  type: "checkbox",
                                  className: "p1c-check",
                                  checked: on.has(rule.code),
                                  onClick: (event) => event.stopPropagation(),
                                  onChange: () => toggleRule(rule.code),
                                }),
                                jsx("span", { className: "p1c-bsl-rules__name", children: rule.name }),
                                jsx("span", {
                                  className: cx("p1c-bsl-rules__sev", severityTone(rule.severity)),
                                  children: rule.severity,
                                }),
                              ],
                            },
                          ),
                        )
                      : jsx("div", { className: "p1c-bsl-rules__empty", children: "Ничего не найдено" }),
                  }),
                ],
              }),
              jsxs("div", {
                className: "p1c-bsl-rules__col",
                children: current
                  ? [
                      jsx("div", { key: "title", className: "p1c-bsl-rules__title", children: current.name }),
                      jsx("div", {
                        key: "meta",
                        className: "p1c-bsl-rules__meta",
                        children: current.code + " · " + current.severity + " · " + current.category,
                      }),
                      jsx("div", {
                        key: "desc",
                        className: "p1c-bsl-rules__scroll",
                        children: jsx("div", {
                          className: "p1c-bsl-rules__desc",
                          children: current.description || "Описание не заполнено",
                        }),
                      }),
                    ]
                  : jsx("div", { className: "p1c-bsl-rules__empty", children: "Выберите правило" }),
              }),
            ],
          });

      const foot = jsxs("div", {
        className: "p1c-dialog__foot",
        children: [
          jsx("div", {
            className: "p1c-dialog__footleft",
            children: jsx("span", {
              className: "p1c-note",
              children: data ? "Включено " + on.size + " из " + rules.length : "",
            }),
          }),
          jsxs("div", {
            className: "p1c-dialog__footright",
            children: [
              jsx(Btn, { onClick: props.onClose, children: "Отмена" }),
              jsx(Btn, { variant: "primary", disabled: saving || !data, onClick: apply, children: "Применить" }),
            ],
          }),
        ],
      });

      return portal(
        jsx("div", {
          className: "p1c-root p1c-overlay",
          children: jsx("div", {
            className: "p1c-dialog",
            style: { width: "980px", maxWidth: "96vw" },
            children: jsxs("div", { children: [head, body, foot, error ? jsx("div", { className: "p1c-note p1c-warn", children: error }) : null] }),
          }),
        }),
      );
    }

    // Экран наборов правил: список, создать копию, переименовать, удалить.
    // Удаление используемого набора откатывает проект на поставку — без
    // подтверждающих окон, строка об этом говорит прямо.
    // Плашка поверх окна: те же форма, цвет и время жизни, что у подсказок
    // редактора, чтобы подтверждения в приложении выглядели одинаково.
    let toastTimer = null;
    function showToast(message) {
      let host = document.querySelector(".p1c-toast");
      if (!host) {
        host = document.createElement("div");
        host.className = "p1c-toast";
        const pill = document.createElement("div");
        pill.className = "p1c-toast__pill";
        host.appendChild(pill);
        document.body.appendChild(host);
      }
      const pill = host.firstChild;
      if (pill) pill.textContent = String(message);
      host.classList.remove("p1c-toast--leaving");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        host.classList.add("p1c-toast--leaving");
        toastTimer = setTimeout(() => {
          if (host.parentNode) host.parentNode.removeChild(host);
          toastTimer = null;
        }, 220);
      }, 2200);
    }

    // ── панель результатов в боковой колонке (better-sidebar) ───────────────
    // Замечания запускает агент; панель показывает последний прогон и даёт
    // принять или вернуть их мышью, без правки файлов руками.
    function sidebarJoin(root, relative) {
      const base = String(root || "").replace(/[\\/]+$/, "");
      const tail = String(relative || "").replace(/\\/g, "/");
      return base + "\\" + tail.replace(/\//g, "\\");
    }

    function SidebarChecksTab(props) {
      const projectPath = (props.scope && props.scope.cwd) || "";
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const [manualPath, setManualPath] = useState("");
      const [running, setRunning] = useState(false);
      // Свёрнутые модули и режим показа пропущенного: пропущенное не должно
      // занимать место, пока его не попросили вернуть.
      const [collapsed, setCollapsed] = useState(new Set());
      const [showSkipped, setShowSkipped] = useState(false);
      // Панель открывается раньше настроек, поэтому стили нужны здесь же:
      // иначе классы p1c-* не определены и текст слипается в кашу.
      injectStyles();

      const load = useCallback(async () => {
        if (!projectPath) return null;
        const payload = await request(CHECKS + "/panel?project=" + encodeURIComponent(projectPath));
        setData(payload);
        setError("");
        return payload;
      }, [projectPath]);

      useEffect(() => {
        let alive = true;
        load().catch((cause) => {
          if (alive) setError(cause.message);
        });
        return () => {
          alive = false;
        };
      }, [load]);

      const acceptFile = async (file) => {
        setBusy(true);
        try {
          await request(CHECKS + "/accept", {
            method: "POST",
            body: JSON.stringify({ project: projectPath, findings: file.findings, by: "user" }),
          });
          await load();
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      };

      // Открыть место замечания: сначала событие для нашего редактора (он умеет
      // вставать на строку), затем обычное открытие файла хостом — на случай,
      // если редактор не перехватывает открытия.
      // Редактор и сайдбар считают путь от корня проекта. Абсолютный путь
      // сюда приходит только если выгрузка лежит вне проекта.
      const relativeToProject = (absolute) => {
        const base = String(projectPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
        const full = String(absolute || "").replace(/\\/g, "/");
        if (!base) return "";
        if (full.toLowerCase().startsWith(base.toLowerCase() + "/")) return full.slice(base.length + 1);
        return "";
      };

      const openAt = (absolute, line, column) => {
        if (!absolute) return;
        const target = relativeToProject(absolute) || absolute;
        try {
          window.dispatchEvent(
            new CustomEvent("dsh-bsl-open-at", {
              detail: { path: target, cwd: projectPath, line: line || undefined, column: column || undefined },
            }),
          );
        } catch {}
        // Запасной путь — обычное открытие файла: хвост «:строка» понимает не
        // каждый обработчик, а путь с ним он может не найти.
        if (props.onOpenFile) props.onOpenFile(target);
      };

      const toggleFold = (path) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      };

      // Пропуск одного замечания: пропускается ровно эта находка, а не весь модуль.
      const skipOne = async (file, finding, restore = false) => {
        setBusy(true);
        try {
          await request(CHECKS + "/accept", {
            method: "POST",
            body: JSON.stringify(
              restore
                ? { project: projectPath, restore: true, keys: [finding.key] }
                : { project: projectPath, findings: [{ ...finding, path: file.path }], by: "user" },
            ),
          });
          await load();
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      };

      const restoreAll = async () => {
        setBusy(true);
        try {
          await request(CHECKS + "/accept", {
            method: "POST",
            body: JSON.stringify({ project: projectPath, all: true, restore: true }),
          });
          await load();
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      };

      // Ручной запуск: файл или папка относительно выгрузки. Папку раскрывает
      // хост, поэтому в поле можно указать «CommonModules» целиком.
      const runCheck = async () => {
        const wanted = manualPath.trim();
        if (!wanted) return;
        setRunning(true);
        try {
          const result = await request(CHECKS + "/check", {
            method: "POST",
            body: JSON.stringify({ project: projectPath, files: [wanted], by: "user" }),
          });
          setData((current) => ({ ...(current || {}), last: result }));
          setError("");
        } catch (cause) {
          setError(cause.message);
        } finally {
          setRunning(false);
        }
      };

      // Текст для агента: шапка с контекстом, дальше по файлам полные адреса
      // «строка:колонка код (важность) — сообщение». Копия в буфер, чтобы
      // вставить в чат вместе со ссылкой на файл.
      const copyFindings = async () => {
        const last = data && data.last;
        if (!last) return;
        const groups = [];
        let total = 0;
        for (const file of last.files || []) {
          const rows = (file.findings || []).filter((finding) => !finding.accepted);
          if (!rows.length) continue;
          total += rows.length;
          groups.push(
            [
              file.path,
              ...rows.map(
                (finding) =>
                  "  " +
                  finding.line +
                  ":" +
                  finding.column +
                  "  " +
                  finding.code +
                  " (" +
                  finding.severity +
                  ") — " +
                  finding.message,
              ),
            ].join("\n"),
          );
        }
        if (!total) return;
        const head =
          "Статический анализ, набор «" +
          (data.presetName || "") +
          "», прогон " +
          new Date(last.checkedAt).toLocaleString("ru-RU") +
          ". Замечаний: " +
          total +
          " в " +
          groups.length +
          " файл(ах). Пути от каталога выгрузки " +
          (last.dumpDir || "") +
          ":";
        try {
          await navigator.clipboard.writeText([head, "", ...groups].join("\n\n"));
          setError("");
          showToast(
            "Скопировано: " + total + " " + plural(total, ["замечание", "замечания", "замечаний"]),
          );
        } catch {
          setError("буфер обмена недоступен");
          showToast("Буфер обмена недоступен");
        }
      };

      const shell = (children) =>
        jsxs("div", { className: "p1c-root p1c-root--panel p1c-stack", style: { padding: "10px" }, children });

      if (!projectPath) return shell([jsx("div", { className: "p1c-note", children: "Проект не определён" })]);
      if (!data) return shell([jsx("div", { className: "p1c-note", children: error || "читаю…" })]);
      if (!data.enabled) {
        return shell([jsx("div", { className: "p1c-note", children: "Статический анализ выключен в параметрах проекта" })]);
      }

      const manualBlock = jsxs("div", {
        className: "p1c-stack p1c-stack--tight",
        children: [
          jsxs("div", {
            className: "p1c-actions",
            children: [
              jsx("input", {
                className: "p1c-input",
                placeholder: "CommonModules/ОбщегоНазначения/Ext/Module.bsl",
                title: "Путь относительно каталога выгрузки. Можно указать папку — она раскроется в модули .bsl.",
                value: manualPath,
                onChange: (event) => setManualPath(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") runCheck();
                },
              }),
              jsx(Btn, {
                variant: "primary",
                disabled: running || !manualPath.trim(),
                onClick: runCheck,
                children: running ? "Проверяю…" : "Проверить",
              }),
            ],
          }),
          jsx("div", {
            className: "p1c-note p1c-sm",
            children: "Путь от каталога выгрузки: модуль или папка. Замечания попадут сюда и станут доступны агенту.",
          }),
        ],
      });

      const last = data.last;
      if (!last) {
        return shell([
          manualBlock,
          jsx("div", {
            className: "p1c-note",
            children: "Проверок ещё не было. Укажите файл или папку выше либо попросите агента проверить файл.",
          }),
        ]);
      }

      const blocks = last.files.map((file) => {
        const open = file.findings.filter((finding) => !finding.accepted);
        const skipped = file.findings.length - open.length;
        const shown = showSkipped ? file.findings : open;
        const folded = collapsed.has(file.path);
        const absolute = sidebarJoin(last.dumpDir, file.path);
        return jsxs(
          "div",
          {
            key: file.path,
            className: "p1c-card",
            children: [
              jsxs("button", {
                type: "button",
                className: "p1c-filehead",
                title: folded ? "Развернуть замечания" : "Свернуть замечания",
                onClick: () => toggleFold(file.path),
                children: [
                  jsx("svg", {
                    className: "p1c-chevron" + (folded ? " p1c-chevron--folded" : ""),
                    width: 12,
                    height: 12,
                    viewBox: "0 0 12 12",
                    "aria-hidden": "true",
                    children: jsx("path", {
                      d: "M2.5 4.5L6 8L9.5 4.5",
                      fill: "none",
                      stroke: "currentColor",
                      strokeWidth: "1.7",
                      strokeLinecap: "round",
                      strokeLinejoin: "round",
                    }),
                  }),
                  jsx("span", { className: "p1c-path p1c-mono p1c-sm", children: file.path }),
                  jsx("span", {
                    className: "p1c-filehead__count",
                    children: open.length
                      ? open.length + " " + plural(open.length, ["замечание", "замечания", "замечаний"])
                      : skipped
                        ? "всё пропущено"
                        : "чисто",
                  }),
                ],
              }),
              folded || !shown.length
                ? null
                : jsx("div", {
                    className: "p1c-stack p1c-stack--tight",
                    children: shown.map((finding) =>
                      jsxs(
                        "div",
                        {
                          key: finding.key || finding.code + finding.line,
                          className: "p1c-finding" + (finding.accepted ? " p1c-finding--skipped" : ""),
                          children: [
                            jsxs("div", {
                              className: "p1c-finding__head",
                              children: [
                                jsx("span", { className: "p1c-finding__pos p1c-mono", children: finding.line + ":" + finding.column }),
                                jsx("span", {
                                  className: "p1c-sev p1c-sev--" + String(finding.severity || "").toLowerCase(),
                                  children: finding.severity,
                                }),

                                jsxs("span", {
                                  className: "p1c-finding__acts",
                                  children: [
                                    jsx("button", {
                                      type: "button",
                                      className: "p1c-linkbtn",
                                      onClick: () => openAt(absolute, finding.line, finding.column),
                                      children: "Перейти",
                                    }),
                                    finding.accepted
                                      ? jsx("button", {
                                          type: "button",
                                          className: "p1c-finding__skip",
                                          title: "Вернуть замечание в работу",
                                          disabled: busy,
                                          onClick: () => skipOne(file, finding, true),
                                          children: "Вернуть",
                                        })
                                      : jsx("button", {
                                          type: "button",
                                          className: "p1c-finding__skip",
                                          title: "Пропустить это замечание: скрыть, править не будем",
                                          disabled: busy,
                                          onClick: () => skipOne(file, finding, false),
                                          children: "Пропустить",
                                        }),
                                  ],
                                }),
                              ],
                            }),
                            jsx("div", { className: "p1c-finding__msg", children: finding.message }),
                            jsx("div", { className: "p1c-finding__code p1c-mono", children: finding.code }),
                          ],
                        },
                      ),
                    ),
                  }),
              jsxs("div", {
                className: "p1c-actions",
                children: [
                  props.onReferenceFile
                    ? jsx(Btn, {
                        onClick: () => props.onReferenceFile(absolute, false),
                        children: "Ссылка на модуль в чат",
                      })
                    : null,
                  open.length
                    ? jsx(Btn, {
                        disabled: busy,
                        onClick: () => acceptFile({ ...file, findings: open }),
                        title: "Пропустить все замечания этого модуля",
                        children: "Пропустить все",
                      })
                    : null,
                ],
              }),
            ],
          },
        );
      });

      const totalOpen = last.files.reduce(
        (sum, file) => sum + file.findings.filter((finding) => !finding.accepted).length,
        0,
      );

      return shell([
        manualBlock,
        last.metadata && last.metadata.symbolsAvailable === false
          ? jsx("div", { className: "p1c-note p1c-note--warn", children: last.metadata.note })
          : null,
        jsxs("div", {
          className: "p1c-panelhead",
          children: [
            jsx("span", {
              className: "p1c-panelhead__meta",
              children:
                "Проверка " +
                new Date(last.checkedAt).toLocaleString("ru-RU") +
                " · " +
                totalOpen +
                " " +
                plural(totalOpen, ["замечание", "замечания", "замечаний"]),
            }),
            data.accepted
              ? jsx("button", {
                  type: "button",
                  className: "p1c-linkbtn",
                  onClick: () => setShowSkipped((current) => !current),
                  children: showSkipped ? "Скрыть пропущенные" : "Показать пропущенные (" + data.accepted + ")",
                })
              : null,
          ],
        }),
        ...blocks,
        jsxs("div", {
          className: "p1c-actions",
          children: [
            jsx(Btn, { disabled: busy || !totalOpen, onClick: copyFindings, children: "Замечания в буфер" }),
            data.accepted
              ? jsx(Btn, {
                  disabled: busy,
                  onClick: restoreAll,
                  title: "Вернуть все пропущенные в работу",
                  children: "Вернуть все",
                })
              : null,
          ],
        }),
        error ? jsx("div", { className: "p1c-note p1c-note--warn", children: error }) : null,
      ]);
    }

    function installSidebarTab(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["betterSidebar"], (bctx) => {
        const service =
          (bctx && bctx.betterSidebar) || (typeof bctx.get === "function" ? bctx.get("betterSidebar") : null);
        if (!service || typeof service.registerTab !== "function") return;
        return service.registerTab({
          id: "1c-bsl-checks",
          title: "Анализ кода 1С",
          description: "Замечания анализатора по файлам, которые проверял агент",
          order: 120,
          single: true,
          component: SidebarChecksTab,
        });
      });
    }

    function Card(props) {
      return jsxs("section", {
        className: "p1c-card",
        children: [
          props.title || props.hint
            ? jsxs("header", {
                children: [
                  props.title ? jsx("div", { className: "p1c-card__title", children: props.title }) : null,
                  props.hint ? jsx("div", { className: "p1c-card__hint", children: props.hint }) : null,
                ],
              })
            : null,
          props.children,
        ],
      });
    }

    function Field(props) {
      return jsxs("div", {
        className: cx("p1c-field", props.wide && "p1c-span2"),
        children: [
          jsxs("div", {
            className: "p1c-label-row",
            children: [
              props.htmlFor
                ? jsx("label", { className: "p1c-label", htmlFor: props.htmlFor, children: props.label })
                : jsx("span", { className: "p1c-label", children: props.label }),
              props.labelExtra ?? null,
            ],
          }),
          props.children,
          props.hint ? jsx("div", { className: "p1c-note", children: props.hint }) : null,
        ],
      });
    }

    function Check(props) {
      return jsxs("label", {
        className: cx("p1c-check-row", props.compact && "p1c-check-row--compact", props.disabled && "is-disabled"),
        title: props.title,
        children: [
          jsx("input", {
            type: "checkbox",
            checked: props.checked,
            disabled: props.disabled,
            onChange: props.onChange,
          }),
          jsx("span", { children: props.children }),
        ],
      });
    }

    function Btn(props) {
      return jsx("button", {
        type: "button",
        title: props.title,
        disabled: props.disabled,
        onClick: props.onClick,
        className: cx("p1c-btn", "p1c-btn--" + (props.variant || "ghost"), props.className),
        children: props.children,
      });
    }

    function Dot(props) {
      return jsx("span", {
        className: cx("p1c-dot", props.tone && "p1c-dot--" + props.tone, props.className),
        title: props.title,
      });
    }

    const ChevronIcon = (props) =>
      jsx("svg", {
        width: props && props.size ? props.size : 14,
        height: props && props.size ? props.size : 14,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        children: jsx("path", { d: "m9 18 6-6-6-6" }),
      });

    /** Сводка раскрывающегося блока: родной маркер details убран, шеврон свой. */
    const Summary = (props) =>
      jsxs("summary", {
        children: [
          jsx("span", { className: "p1c-details__chev", children: jsx(ChevronIcon, { size: 12 }) }),
          jsx("span", { children: props.children }),
        ],
      });

    /**
     * Состояние операции Конфигуратора отдельным боксом: состояние, тип операции,
     * метрики сеткой, каталог и (для провала) причина. Кнопки передаются снаружи —
     * в окне проекта рядом стоят кнопки запуска, на главной вкладке — «Открыть»/«Отменить».
     */
    function JobBox(props) {
      const { job } = props;
      const metrics = [
        props.showProject && job.title ? ["Проект", job.title] : null,
        ["Время", Math.round((job.elapsedMs || 0) / 1000) + " с"],
        job.counts && job.files ? ["Файлов", String(job.files)] : null,
        job.version ? ["Версия", job.version] : null,
      ].filter(Boolean);
      return jsxs("div", {
        className: "p1c-job",
        children: [
          jsxs("div", {
            className: "p1c-job__head",
            children: [
              jsx(Dot, { tone: JOB_TONE[job.state] || undefined }),
              jsx("span", {
                className: cx("p1c-job__state", JOB_TONE[job.state] && "p1c-text--" + JOB_TONE[job.state]),
                children: JOB_TITLE[job.state] || job.state,
              }),
              job.label ? jsx("span", { className: "p1c-job__op", children: job.label }) : null,
            ],
          }),
          metrics.length
            ? jsx("div", {
                className: "p1c-job__grid",
                children: metrics.map(([key, value]) =>
                  jsxs("div", {
                    key: key,
                    children: [
                      jsx("span", { className: "p1c-job__key", children: key + ": " }),
                      jsx("span", { children: value }),
                    ],
                  }),
                ),
              })
            : null,
          job.dir ? jsx("div", { className: "p1c-job__dir p1c-mono", children: job.dir }) : null,
          job.state === "failed" && job.error
            ? jsx("div", { className: "p1c-note p1c-note--err", children: job.error })
            : null,
          props.actions ? jsx("div", { className: "p1c-actions", children: props.actions }) : null,
        ],
      });
    }

    const CloseIcon = () =>
      jsxs("svg", {
        width: 15,
        height: 15,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        children: [jsx("path", { d: "M18 6 6 18" }), jsx("path", { d: "m6 6 12 12" })],
      });

    const INDEX_STATUS = {
      missing: { text: "индекса нет", tone: "warn" },
      fresh: { text: "актуален", tone: "ok" },
      stale_age: { text: "устарел по возрасту", tone: "warn" },
      stale_content: { text: "устарел: файлы изменились", tone: "warn" },
      stale_structure: { text: "устарел: структура изменилась", tone: "warn" },
      unknown: { text: "состояние неизвестно", tone: "" },
      // Проверка не закончилась за отведённое время: индекс есть, состав файлов не сверяли.
      unchecked: { text: "состав файлов не проверен", tone: "" },
      error: { text: "ошибка проверки", tone: "err" },
      unavailable: { text: "средство индексации не установлено", tone: "err" },
    };

    /** Время прогона из настроек — ISO-строка, показываем по-человечески. */
    const whenText = (value) => {
      if (!value) return "неизвестно";
      const at = new Date(value);
      return Number.isNaN(at.getTime()) ? String(value) : at.toLocaleString("ru-RU");
    };

    /**
     * Карточка индекса rlm в окне проекта. Маршруты живут в dsh-rlm-tools-bsl:
     * /rlm/index/state, /rlm/index/config, /rlm/index/job, /rlm/index/cancel.
     * Плагина может не быть — тогда карточка говорит об этом прямо.
     */
    function RlmIndexCard(props) {
      const { path } = props;
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      // Галочка — намерение из параметров проекта, а не вывод из статуса индекса.
      const [flags, setFlags] = useState(null);
      const [indexPathDraft, setIndexPathDraft] = useState("");
      const autoRef = useRef(false);
      // Первое чтение состояния после открытия карточки помечается как «проект открыт»:
      // плагин запускает по этой метке сборку отсутствующего индекса.
      const openRef = useRef(false);

      const load = useCallback(async (silent = false) => {
        try {
          const next = await rlmRequest(
            "/index/state?open=" + (openRef.current ? "0" : "1") + "&path=" + encodeURIComponent(path)
          );
          openRef.current = true;
          setData(next);
          setError(null);
          const status = next.index && next.index.status;
          // «Структура изменилась» обновлением не лечится: update строит дельту по тому, что
          // видит git, а проверка свежести обходит все папки — расхождение остаётся после каждого
          // прогона. Такой статус требует полной пересборки, и запускает её человек, не автообновление.
          const running = next.job && next.job.state === "running";
          if (
            !silent &&
            !autoRef.current &&
            next.enabled &&
            !running &&
            (status === "stale_age" || status === "stale_content")
          ) {
            autoRef.current = true;
            await rlmRequest("/index/job", { method: "POST", body: JSON.stringify({ path, action: "update" }) }).catch(() => null);
            setTimeout(() => load(true), 800);
          }
        } catch (e) {
          setError(e);
        }
      }, [path]);

      useEffect(() => {
        autoRef.current = false;
        openRef.current = false;
        load();
      }, [load]);

      // Флаги читаются отдельным запросом: файл параметров проекта отдаётся за миллисекунды,
      // без запуска CLI, поэтому галочка и путь не ждут проверку свежести.
      useEffect(() => {
        let alive = true;
        rlmRequest("/index/state?flags=1&path=" + encodeURIComponent(path))
          .then((next) => {
            if (!alive || !next) return;
            setFlags(next);
            setIndexPathDraft(typeof next.indexPath === "string" ? next.indexPath : "");
          })
          .catch(() => null);
        return () => {
          alive = false;
        };
      }, [path]);

      useEffect(() => {
        if (data && data.checking) {
          const timer = setTimeout(() => load(true), 1200);
          return () => clearTimeout(timer);
        }
        if (!data || !data.job || data.job.state !== "running") return;
        const timer = setInterval(() => load(true), 2000);
        return () => clearInterval(timer);
      }, [data, load]);

      const toggle = async (enabled) => {
        setBusy(true);
        try {
          // Флаг — в параметры проекта (.dsh/1c-project.json); карта rlm-плагина
          // синхронизируется следом, чтобы автообновление знало путь.
          await request("/project-index", { method: "POST", body: JSON.stringify({ path, enabled }) });
          const next = await rlmRequest("/index/config", { method: "POST", body: JSON.stringify({ path, enabled }) });
          setFlags((current) => ({ ...(current || {}), enabled }));
          setData(next);
          setError(null);
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      };

      const saveIndexPath = async () => {
        setBusy(true);
        try {
          const next = await request("/project-index", {
            method: "POST",
            body: JSON.stringify({ path, indexPath: indexPathDraft.trim() }),
          });
          setFlags((current) => ({ ...(current || {}), enabled: next.enabled, indexPath: next.indexPath || "" }));
          await load(true);
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      };

      const run = async (action) => {
        setBusy(true);
        try {
          await rlmRequest("/index/job", { method: "POST", body: JSON.stringify({ path, action }) });
          await load(true);
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      };

      if (error && (error.status === 404 || error.status === 0)) {
        return jsx(Card, {
          title: "Синтаксическая индексация",
          children: jsx("div", {
            className: "p1c-note p1c-note--warn",
            children: "Плагин dsh-rlm-tools-bsl не установлен — индексом управлять нечем.",
          }),
        });
      }

      const index = data && data.index ? data.index : null;
      const job = data && data.job ? data.job : null;
      const project = data && data.project ? data.project : null;
      const jobPath = job ? job.project || job.path : "";
      const sameJob = Boolean(jobPath && jobPath.toLowerCase() === path.toLowerCase());
      // Состояние ещё проверяется: галочка и статус не должны врать в это время.
      const checking = Boolean(data && data.checking);
      const running = Boolean(job && job.state === "running" && sameJob);
      const anyRunning = Boolean(job && job.state === "running");
      const status = index ? index.status : "unknown";
      const info = INDEX_STATUS[status] || INDEX_STATUS.unknown;
      const label = running
        ? job.action === "update"
          ? "обновляется…"
          : "собирается…"
        : checking
          ? "проверяю…"
          : info.text;
      // «Обновить» строит дельту по тому, что видит git, и не замечает файлы из .gitignore;
      // проверка свежести обходит все папки. Для расхождения состава нужна полная пересборка.
      const structureStale = status === "stale_structure";
      const action = status === "missing" || structureStale ? "build" : "update";
      const actionLabel = status === "missing" ? "Собрать" : structureStale ? "Пересобрать" : "Обновить";
      const canRun = Boolean(data && data.bin && data.enabled) && !anyRunning && !busy;

      return jsx(Card, {
        title: "Синтаксическая индексация проекта",
        children: jsxs("div", {
          className: "p1c-stack",
          children: [
            jsxs("div", {
              style: { display: "flex", alignItems: "center", gap: 8 },
              children: [
                jsx(Dot, { tone: running ? "warn" : checking ? "" : info.tone }),
                jsx("div", { className: "p1c-sm", children: label }),
                anyRunning && !sameJob
                  ? jsx("div", { className: "p1c-note", children: "идёт операция по другому проекту" })
                  : null,
              ],
            }),
            error && error.status !== 0 && error.status !== 404
              ? jsx("div", { className: "p1c-note p1c-note--err", children: String(error.message || error) })
              : null,
            index && index.size
              ? jsxs("div", {
                  className: "p1c-rows",
                  children: [
                    jsx(Row, { label: "Размер", value: index.size }),
                    jsx(Row, { label: "Собрано", value: index.built || "неизвестно" }),
                  ],
                })
              : null,
            index && index.dbPath ? jsx("div", { className: "p1c-note p1c-mono", children: index.dbPath }) : null,
            data && data.target && data.target.custom
              ? jsxs("div", {
                  className: "p1c-note",
                  children: ["Индексируется папка выгрузки: ", jsx("span", { className: "p1c-mono", children: data.target.path })],
                })
              : null,
            // Сработавший таймаут проверки — не поломка: текст нейтральный, без красного.
            index && index.error && index.status !== "missing"
              ? jsx("div", {
                  className: status === "unchecked" ? "p1c-note" : "p1c-note p1c-note--err",
                  children: index.error,
                })
              : null,
            project && project.lastError && !running
              ? jsxs("div", {
                  className: "p1c-note p1c-note--err",
                  children: [
                    "Последняя попытка ",
                    whenText(project.lastAttemptAt),
                    " завершилась ошибкой: ",
                    String(project.lastError),
                  ],
                })
              : null,
            // Автосборка остановлена до перезапуска: повторять детерминированный отказ бессмысленно, а
            // без этой строки человек ждёт, что «само поправится». Ручная кнопка снимает остановку.
            project && project.autoStopped && !running
              ? jsx("div", { className: "p1c-note p1c-note--warn", children: "Автосборка индекса остановлена до перезапуска: повторять этот отказ автоматически нечего. Исправьте путь в параметрах проекта или нажмите «Пересобрать»." })
              : null,
            project && !project.lastError && !running && status === "missing" && project.lastAttemptAt
              ? jsxs("div", {
                  className: "p1c-note p1c-note--warn",
                  children: ["Последняя попытка ", whenText(project.lastAttemptAt), " прошла, но индекса в итоге нет."],
                })
              : null,
            project && project.partial && !running
              ? jsxs("div", {
                  className: "p1c-note p1c-note--warn",
                  children: [
                    "Индекс собран в неполном режиме: формат исходников не cf и не 1С:EDT, поэтому метаданные и навигация по объектам не гарантируются — доступен только поиск по тексту BSL. Для полного индекса выгрузите конфигурацию в файлы средствами Конфигуратора.",
                  ],
                })
              : null,
            data && data.logFile && project && project.lastError && !running
              ? jsxs("div", { className: "p1c-note p1c-mono", children: ["журнал: ", String(data.logFile)] })
              : null,
            structureStale && !running
              ? jsx("div", {
                  className: "p1c-note p1c-note--warn",
                  children:
                    "На диске не тот набор файлов .bsl, что записан в индексе. Обновление этот рассинхрон не убирает: оно видит только изменения, известные git, а папки из .gitignore для него не существуют. «Пересобрать» считает файлы обходом папок и снова сходится с проверкой.",
                })
              : null,
            jsx(Check, {
              checked: Boolean(flags ? flags.enabled : data && data.enabled),
              disabled: busy || anyRunning || !(flags || data),
              onChange: (event) => toggle(event.target.checked),
              children: flags || data ? "индексировать проект" : "читаю параметры проекта…",
            }),
            jsx(Field, {
              wide: true,
              htmlFor: "p1c-rlm-path",
              label: "Папка выгрузки",
              hint: "Что индексировать. Пусто — папка проекта: " + path,
              children: jsx("input", {
                id: "p1c-rlm-path",
                className: "p1c-input",
                value: indexPathDraft,
                placeholder: path,
                disabled: busy || anyRunning,
                onChange: (event) => setIndexPathDraft(event.target.value),
                onBlur: () => saveIndexPath(),
                onKeyDown: (event) => {
                  if (event.key === "Enter") saveIndexPath();
                },
              }),
            }),
            running
              ? jsx(JobBox, {
                  job: {
                    state: job.state,
                    label: job.action === "update" ? "Обновление индекса" : "Сборка индекса",
                    elapsedMs: job.elapsedMs,
                    dir: path,
                    error: job.error,
                    log: (job.lines || []).join("\n"),
                  },
                  actions: jsx(Btn, {
                    variant: "danger",
                    disabled: busy,
                    onClick: () => rlmRequest("/index/cancel", { method: "POST" }).then(() => load(true)).catch(() => {}),
                    children: "Отменить",
                  }),
                })
              : null,
            data && !data.bin
              ? jsx("div", {
                  className: "p1c-note p1c-note--warn",
                  children:
                    "средство индексации не установлено: его ставит установщик при первой раскатке каталога (uv и пакет rlm-tools-bsl). Перезапустите приложение; если не помогло — причина в журнале раскатки catalog-seed.log в доме DSH.",
                })
              : null,
            jsx("div", {
              className: "p1c-actions",
              children: [jsx(Btn, {
                variant: "primary",
                disabled: !canRun,
                title: data && !data.bin ? "средство индексации не установлено" : data && !data.enabled ? "сначала включите «индексировать проект»" : undefined,
                onClick: () => run(action),
                children: actionLabel,
              }), structureStale ? jsx(Btn, {
                disabled: !canRun,
                title: "Только изменения, которые видит git: секунды. Состав файлов на диске обновление не сверяет.",
                onClick: () => run("update"),
                children: "Обновить",
              }) : null],
            }),
            jsx("div", {
              className: "p1c-note",
              children: "Полная сборка — несколько минут, обновление — секунды. Пересборка нужна при смене схемы индекса и когда проверка видит на диске не тот набор файлов.",
            }),
          ],
        }),
      });
    }

    const EMPTY_FORM = { infobasePath: "", user: "", password: "", platformPath: "", unlockCode: "", dumpDir: "" };

    const EMPTY_RUN = { format: "Hierarchical", update: false, cleanLocks: false };

    // Параметры обратной загрузки: по умолчанию обновляем и конфигурацию базы,
    // причём динамически — так не нужно выгонять пользователей из базы.
    const EMPTY_LOAD = { updateDb: true, dynamic: true };

    // Разделы развёртывания правил: тот же полный список понимает хост-часть,
    // и разворачивается всегда целиком — выбирать подмножество в UI не нужно.
    const EMPTY_RULES_OPTIONS = { includePassword: false, useEdt: false };

    const STATUS_LABEL = {
      written: "записано",
      unchanged: "без изменений",
      preserved: "сохранено ваше",
      removed: "удалено",
    };

    /** Подписи строки-итога в отчёте развёртывания (читаются как «записано файлов: 102»). */
    const RESULT_LABEL = {
      written: "записано файлов",
      unchanged: "без изменений",
      preserved: "сохранено ваших",
      removed: "удалено",
    };

    /** Заголовок бокса операции: с большой буквы, читается как состояние. */
    const JOB_TITLE = {
      running: "Операция идёт",
      done: "Операция завершена",
      failed: "Операция не удалась",
      cancelled: "Операция отменена",
    };

    const JOB_TONE = { running: null, done: "ok", failed: "err", cancelled: "err" };

    // ── визард добавления проекта ─────────────────────────────────────────────
    //
    // Кнопка добавления проекта в DSH создаёт воркспейс и ничего не спрашивает.
    // Плагин подхватывает это создание: если в папке ещё нет .dsh/1c-project.json,
    // показываем визард из пяти шагов и раскладываем то, что нужно проекту 1С —
    // база, платформа, правила, выгрузка. Обычный проект закрывает визард на
    // первом шаге, и в его папке ничего не появляется.

    const WIZARD_PLATFORM_LIST = "dsh-1cprops-wizard-platforms";
    const WIZARD_INFOBASE_LIST = "dsh-1cprops-wizard-infobases";

    /** Наличие payload comol в состоянии хоста и подписи. */
    function readRulesets(state) {
      const pack = (state && state.rulesPayloads) || {};
      const payload = pack.comol || (state && state.rulesPayload) || null;
      return [
        {
          id: "comol",
          title: pack.title || "Правила comol",
          hint:
            pack.hint ||
            "Правила, роли субагентов, команды, навыки и OpenSpec — нужны MCP-серверы comol.",
          repo: pack.repo || "https://github.com/comol/ai_rules_1c",
          payloadDir: "1c-rules",
          available: Boolean(payload && payload.ok),
          root: (payload && payload.root) || "",
        },
      ];
    }

    /** Флажок «добавить comol»: наши правила разворачиваются всегда. */
    function RulesetPicker(props) {
      const set = (props.sets || [])[0] || null;
      const available = Boolean(set && set.available);
      return jsxs("div", {
        className: "p1c-radio",
        children: [
          jsx(Check, {
            checked: props.value === "comol",
            disabled: props.disabled || !available,
            title: available ? set.hint : "Набор comol не найден в DSH" + (set && set.root ? ": " + set.root : ""),
            onChange: (event) => props.onChange(event.target.checked && set ? "comol" : ""),
            children: "Добавить правила comol",
          }),
          jsx("span", { className: "p1c-radio__hint", children: available ? set.hint : "Набор comol не найден в DSH" }),
        ],
      });
    }
    const WIZARD_HOOK = "__dsh1cProjectWizard";

    let wizardRequest = null;
    const wizardListeners = new Set();

    function notifyWizard() {
      for (const listener of wizardListeners) {
        try {
          listener();
        } catch {}
      }
    }

    function openWizard(request) {
      wizardRequest = { ...request, openedAt: Date.now() };
      notifyWizard();
    }

    function closeWizard() {
      wizardRequest = null;
      notifyWizard();
    }

    function useWizardRequest() {
      const [value, setValue] = useState(wizardRequest);
      useEffect(() => {
        const listener = () => setValue(wizardRequest);
        wizardListeners.add(listener);
        return () => {
          wizardListeners.delete(listener);
        };
      }, []);
      return value;
    }

    /**
     * Создан воркспейс — спрашиваем хост, что лежит в папке. Визард открывается
     * всегда, кроме одного случая: у проекта уже есть файл параметров, то есть
     * его настраивали раньше. Отказ хоста — молчание: визард не обязан быть.
     */
    async function offerWizard(workspace) {
      const path = workspace && typeof workspace.path === "string" ? workspace.path : "";
      if (!path) return;
      let found = null;
      try {
        found = await request("/detect?path=" + encodeURIComponent(path));
      } catch {
        return;
      }
      if (!found || found.hasParams === true) return;
      openWizard({ path, title: workspace.title || path, detect: found });
    }

    /**
     * Создание воркспейса идёт через службу workspaces, и другого пути у кнопки
     * «добавить проект» нет: и боковая панель, и пустой экран диалога зовут её же.
     * Оборачиваем метод и возвращаем как было при выгрузке плагина.
     */
    function installCreateHook(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["workspaces"], (wctx) => {
        const service = (wctx && wctx.workspaces) || (typeof wctx.get === "function" ? wctx.get("workspaces") : null);
        if (!service || typeof service.create !== "function") return;
        const original = service.create;
        if (original[WIZARD_HOOK]) return;
        const wrapped = async function create(input) {
          const workspace = await original.call(service, input);
          Promise.resolve()
            .then(() => offerWizard(workspace))
            .catch(() => {});
          return workspace;
        };
        Object.defineProperty(wrapped, WIZARD_HOOK, { value: true });
        Object.defineProperty(service, "create", { value: wrapped, writable: true, configurable: true });
        if (typeof wctx.effect === "function") {
          wctx.effect(() => () => {
            if (service.create === wrapped) delete service.create;
          });
        }
      });
    }

    /** Короткая причина отказа префлайта: в статусе нужен смысл, а не путь. */
    function shortPathError(result) {
      const bad = ((result && result.checks) || []).find((item) => !item.ok);
      if (!bad) return "проверка не прошла";
      if (bad.label === "Платформа") return "платформа 1С не найдена";
      if (bad.label === "База") return "базы по указанному пути нет";
      if (bad.label === "Сервер") return "сервер 1С не отвечает";
      return bad.detail || "проверка не прошла";
    }

    /** Слот общего слоя: визард показывается над приложением, а не внутри настроек. */
    function WizardHost() {
      const current = useWizardRequest();
      if (!current) return null;
      return jsx(Wizard, { key: String(current.openedAt), request: current, onClose: closeWizard });
    }

    function Radio(props) {
      return jsxs("label", {
        className: cx("p1c-check-row", props.disabled && "is-disabled"),
        htmlFor: props.id,
        children: [
          jsx("input", {
            id: props.id,
            type: "radio",
            name: props.name,
            checked: props.checked,
            disabled: props.disabled,
            onChange: props.onChange,
          }),
          jsx("span", { children: props.children }),
        ],
      });
    }

    function Row(props) {
      return jsxs("div", {
        className: "p1c-row",
        children: [
          jsx("span", { className: "p1c-row__key", children: props.label }),
          jsx("span", {
            className: cx("p1c-row__value", props.tone && "p1c-text--" + props.tone),
            children: props.value,
          }),
        ],
      });
    }

    /** Отчёт развёртывания правил: один и тот же на шаге визарда и в окне проекта. */
    function RulesReport(props) {
      const result = props.result;
      if (!result) return null;
      const summary = result.summary
        ? Object.entries(RESULT_LABEL)
            .filter(([key]) => Number(result.summary[key]) > 0)
            .map(([key, label]) => label + ": " + result.summary[key])
            .join(" · ")
        : "";
      const preserved = (result.files || []).filter((file) => file.status === "preserved");
      return jsxs("div", {
        className: "p1c-stack p1c-stack--tight",
        children: [
          jsx("div", {
            className: cx("p1c-sm p1c-strong", result.ok === false && "p1c-text--err"),
            children:
              result.ok === false
                ? "Развернуть не удалось"
                : result.dryRun
                  ? "Предпросмотр (ничего не записано)"
                  : "Развёртывание выполнено",
          }),
          result.ok === false
            ? jsx("div", { className: "p1c-note p1c-note--err", children: String(result.error || "причина не сообщена") })
            : jsx("div", { className: "p1c-note", children: summary || "изменений нет" }),
          ...(result.notes || []).map((note, index) =>
            jsx("div", { key: "n" + index, className: "p1c-note", children: note }),
          ),
          ...(result.warnings || []).map((warning, index) =>
            jsx("div", { key: "w" + index, className: "p1c-note p1c-note--warn", children: warning }),
          ),
          preserved.length
            ? jsxs("div", {
                className: "p1c-note",
                children: [
                  jsx("div", { children: "Оставлено ваше (" + preserved.length + "):" }),
                  ...preserved.slice(0, 3).map((file, index) =>
                    jsx("div", { key: index, className: "p1c-mono", children: file.path + (file.detail ? " — " + file.detail : "") }),
                  ),
                  preserved.length > 3 ? jsx("div", { children: "и ещё " + (preserved.length - 3) }) : null,
                ],
              })
            : null,
        ],
      });
    }


    function Wizard(props) {
      const { request: target, onClose } = props;
      const [state, setState] = useState(null);
      const [step, setStep] = useState(0);
      const [detect, setDetect] = useState(target.detect || null);
      const [is1c, setIs1c] = useState(target.detect ? Boolean(target.detect.is1c) : null);
      const [form, setForm] = useState({ ...EMPTY_FORM, ...((target.detect && target.detect.params) || {}) });
      const [showPassword, setShowPassword] = useState(false);
      const [rulesOptions, setRulesOptions] = useState(EMPTY_RULES_OPTIONS);
      const [rulesResult, setRulesResult] = useState(null);
      const [runOptions, setRunOptions] = useState(EMPTY_RUN);
      const [job, setJob] = useState(null);
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState(null);
      const [baseSaved, setBaseSaved] = useState(false);
      const [mcp, setMcp] = useState(null);
      const [indexRlm, setIndexRlm] = useState(false);
      const [indexPath, setIndexPath] = useState("");
      const [pathCheck, setPathCheck] = useState(null);
      const [connection, setConnection] = useState(null);
      const [checking, setChecking] = useState(false);
      // Что уже лежит в файле параметров: по этому признаку визард понимает,
      // есть ли что сохранять при уходе с шага. Он же и есть второе хранилище — файл проекта.
      const [lastSaved, setLastSaved] = useState(
        JSON.stringify({ ...EMPTY_FORM, ...((target.detect && target.detect.params) || {}) }),
      );
      injectStyles();

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
      }, [onClose]);

      useEffect(() => {
        let alive = true;
        request("/state")
          .then((data) => {
            if (alive) setState(data);
          })
          .catch((error) => {
            if (alive) setStatus({ kind: "error", text: String((error && error.message) || error) });
          });
        return () => {
          alive = false;
        };
      }, []);

      const refreshJob = useCallback(async () => {
        try {
          const data = await request("/dump-status");
          setJob(data.job);
        } catch {}
      }, []);

      useEffect(() => {
        if (step === 2 || step === 3) refreshJob();
      }, [step, refreshJob]);

      useEffect(() => {
        if (!job || job.state !== "running") return;
        const timer = setInterval(refreshJob, 2000);
        return () => clearInterval(timer);
      }, [job && job.state, refreshJob]);

      useEffect(() => {
        if (step !== 4) return;
        let alive = true;
        request("/mcp-servers")
          .then((data) => {
            if (alive) setMcp(data);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [step]);

      const running = Boolean(job && job.state === "running");
      const locked = busy || running;

      const saveBase = () =>
        request("/project-save", {
          method: "POST",
          body: JSON.stringify({ path: target.path, params: form }),
        }).then((data) => {
          setBaseSaved(true);
          setLastSaved(JSON.stringify(form));
          return data;
        });

      const dirty = JSON.stringify(form) !== lastSaved;

      const submitBase = async () => {
        setBusy(true);
        setStatus(null);
        try {
          await saveBase();
          setStatus({ kind: "ok", text: "Параметры базы сохранены" });
          setStep(2);
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
        } finally {
          setBusy(false);
        }
      };

      // Завершение визарда: флаг индекса — в общие настройки, сборка — в фоне.
      // Если плагина rlm нет, визард всё равно закрывается: проект настроен.
      const finishWizard = async () => {
        setBusy(true);
        try {
          await request("/project-index", {
            method: "POST",
            body: JSON.stringify({ path: target.path, enabled: indexRlm, indexPath: indexPath.trim() }),
          });
          await rlmRequest("/index/config", {
            method: "POST",
            body: JSON.stringify({ path: target.path, enabled: indexRlm }),
          });
          if (indexRlm) {
            await rlmRequest("/index/job", {
              method: "POST",
              body: JSON.stringify({ path: target.path, action: "build" }),
            }).catch(() => null);
          }
        } catch {
          // rlm-плагин может быть не установлен
        } finally {
          setBusy(false);
          onClose();
        }
      };

      // Развёртывание правил: наш слой всегда, comol — если стоит флажок.
      const deployRules = async () => {
        setBusy(true);
        setStatus(null);
        try {
          const result = await request("/rules-deploy", {
            method: "POST",
            body: JSON.stringify({
              path: target.path,
              withComol: rulesOptions.base === "comol",
              includePassword: rulesOptions.includePassword,
              useEdt: rulesOptions.useEdt,
            }),
          });
          setRulesResult(result);
        } catch (error) {
          setRulesResult({ ok: false, error: String((error && error.message) || error) });
        } finally {
          setBusy(false);
        }
      };

      // Одна кнопка, две ступени внутри неё. Сначала мгновенное и без 1С: путь к
      // платформе, каталог базы и файл 1Cv8.1CD, доступность сервера — звать
      // платформу незачем, если каталога нет. Затем внешнее соединение: платформа
      // авторизуется и открывает базу на чтение, без Конфигуратора и без блокировок.
      const runCheck = async () => {
        setBusy(true);
        setChecking(true);
        setStatus(null);
        setPathCheck(null);
        setConnection(null);
        try {
          const local = await request("/path-check", {
            method: "POST",
            body: JSON.stringify({ path: target.path, params: form }),
          });
          setPathCheck(local);
          if (!local.okAll) return;
          const data = await request("/check-connection", {
            method: "POST",
            body: JSON.stringify({ path: target.path, params: form }),
          });
          setConnection(data);
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
        } finally {
          setBusy(false);
          setChecking(false);
        }
      };

      const leaveDump = async () => {
        if (!dirty) {
          setStep(4);
          return;
        }
        setBusy(true);
        setStatus(null);
        try {
          await saveBase();
          setStep(4);
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
        } finally {
          setBusy(false);
        }
      };

      const startDump = async () => {
        setBusy(true);
        setStatus(null);
        try {
          await saveBase();
          const data = await request("/dump-start", {
            method: "POST",
            body: JSON.stringify({
              path: target.path,
              dir: form.dumpDir,
              format: runOptions.format,
              update: runOptions.update,
              cleanLocks: runOptions.cleanLocks,
            }),
          });
          setJob(data.job);
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
        } finally {
          setBusy(false);
        }
      };

      const cancelDump = async () => {
        setBusy(true);
        try {
          const data = await request("/dump-cancel", { method: "POST", body: JSON.stringify({ path: target.path }) });
          setJob(data.job);
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
        } finally {
          setBusy(false);
        }
      };

      const platforms = (state && state.platforms) || [];
      const infoBases = (state && state.infobases) || [];
      const commonPlatform = (state && state.common && state.common.platformPath) || "";
      const rulesets = readRulesets(state);
      const rulesBase = rulesOptions.base;
      const rulesSet = rulesets[0] || null;
      // Наш слой не зависит от payload'а: кнопка доступна всегда.
      const rulesReady = true;
      const canRun = Boolean(form.infobasePath) && baseSaved;

      const statusLine = status
        ? jsxs("div", {
            className: "p1c-status",
            children: [
              jsx(Dot, { className: "p1c-status__dot", tone: status.kind === "ok" ? "ok" : "err" }),
              jsx("div", {
                className: cx("p1c-sm", status.kind === "ok" ? "p1c-text--ok" : "p1c-text--err"),
                children: status.text,
              }),
            ],
          })
        : null;

      const markers = (detect && detect.markers) || [];
      const detectHint = markers.length
        ? "Похоже на 1С: " + markers[0] + (markers.length > 1 ? " и ещё " + (markers.length - 1) : "") + "."
        : "Признаков 1С в папке не нашёл.";

      const stepKind = jsx(Card, {
        title: "Это проект 1С?",
        hint: "Если проект не 1С, окно закроется — в его папке ничего не появится.",
        children: jsxs("div", {
          className: "p1c-stack p1c-stack--tight",
          children: [
            jsxs("div", {
              className: "p1c-options",
              children: [
                jsx(Radio, {
                  id: "p1c-wizard-yes",
                  name: "p1c-wizard-kind",
                  checked: is1c === true,
                  onChange: () => setIs1c(true),
                  children: "Да, это проект 1С",
                }),
                jsx(Radio, {
                  id: "p1c-wizard-no",
                  name: "p1c-wizard-kind",
                  checked: is1c === false,
                  onChange: () => setIs1c(false),
                  children: "Нет, обычный проект",
                }),
              ],
            }),
            jsx("div", { className: "p1c-note", title: markers.join("; "), children: detectHint }),
          ],
        }),
      });

      // Статус проверки — одна горизонтальная строка. Пути к базе и платформе тут
      // лишние: они и так в полях выше, в статусе нужен только вердикт.
      const checkTone = checking
        ? "warn"
        : connection
          ? connection.ok
            ? "ok"
            : "err"
          : pathCheck && !pathCheck.okAll
            ? "err"
            : "";
      const checkText = checking
        ? "Проверяю подключение…"
        : connection
          ? connection.ok
            ? "Подключение работает" + (connection.elapsedMs ? " · " + (connection.elapsedMs / 1000).toFixed(1) + " с" : "")
            : connection.error || "База не открылась"
          : pathCheck && !pathCheck.okAll
            ? shortPathError(pathCheck)
            : "";
      const checkLine = checkText
        ? jsxs("div", {
            className: "p1c-check-line p1c-check-line--status",
            children: [
              jsx(Dot, { key: "dot", tone: checkTone }),
              jsx("span", { key: "text", className: checkTone === "err" ? "p1c-text--err" : undefined, children: checkText }),
            ],
          })
        : null;

      const stepBase = jsxs("div", {
        className: "p1c-stack",
        children: [
          jsx(Card, {
            title: "База 1С",
            children: [
              jsxs("div", {
                className: "p1c-grid",
                children: [
                  jsx(Field, {
                    wide: true,
                    htmlFor: "p1c-wizard-infobase",
                    label: "Путь к базе",
                    children: jsx("input", {
                      id: "p1c-wizard-infobase",
                      className: "p1c-input",
                      list: WIZARD_INFOBASE_LIST,
                      autoFocus: true,
                      value: form.infobasePath,
                      placeholder: 'C:/Базы/Бухгалтерия  либо  Srvr="server";Ref="buh";',
                      onChange: (e) => setForm((f) => ({ ...f, infobasePath: e.target.value })),
                    }),
                  }),
                  jsx(Field, {
                    htmlFor: "p1c-wizard-user",
                    label: "Пользователь",
                    children: jsx("input", {
                      id: "p1c-wizard-user",
                      className: "p1c-input",
                      value: form.user,
                      onChange: (e) => setForm((f) => ({ ...f, user: e.target.value })),
                    }),
                  }),
                  jsx(Field, {
                    htmlFor: "p1c-wizard-password",
                    label: "Пароль",
                    labelExtra: jsx(Check, {
                      compact: true,
                      checked: showPassword,
                      onChange: (e) => setShowPassword(e.target.checked),
                      children: "показать",
                    }),
                    hint: "Открытым текстом в файле проекта.",
                    children: jsx("input", {
                      id: "p1c-wizard-password",
                      className: "p1c-input",
                      type: showPassword ? "text" : "password",
                      value: form.password,
                      onChange: (e) => setForm((f) => ({ ...f, password: e.target.value })),
                    }),
                  }),
                ],
              }),
              jsxs("details", {
                className: "p1c-details",
                children: [
                  jsx(Summary, { children: "Дополнительно: код доступа и платформа" }),
                  jsxs("div", {
                    className: "p1c-grid",
                    children: [
                      jsx(Field, {
                        htmlFor: "p1c-wizard-unlock",
                        label: "Код доступа к базе",
                        hint: "Нужен, если на базе стоит блокировка соединений (/UC).",
                        children: jsx("input", {
                          id: "p1c-wizard-unlock",
                          className: "p1c-input",
                          value: form.unlockCode,
                          placeholder: "пусто — без кода",
                          onChange: (e) => setForm((f) => ({ ...f, unlockCode: e.target.value })),
                        }),
                      }),
                      jsx(Field, {
                        htmlFor: "p1c-wizard-platform",
                        label: "Платформа для проекта",
                        hint: form.platformPath
                          ? "Путь задан для этого проекта."
                          : commonPlatform
                            ? "Пусто — берётся общее значение из настроек."
                            : "Общее значение не задано — укажите путь к платформе.",
                        children: jsx("input", {
                          id: "p1c-wizard-platform",
                          className: "p1c-input",
                          list: WIZARD_PLATFORM_LIST,
                          value: form.platformPath,
                          placeholder: commonPlatform || "C:/Program Files/1cv8/…/bin/1cv8.exe",
                          onChange: (e) => setForm((f) => ({ ...f, platformPath: e.target.value })),
                        }),
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          jsxs("div", {
            className: "p1c-actions",
            children: [
              jsx(Btn, {
                variant: "primary",
                disabled: busy || running || !form.infobasePath,
                title: form.infobasePath
                  ? "1С подключится к базе этими данными — пара секунд, без Конфигуратора"
                  : "Сначала укажите путь к базе",
                onClick: runCheck,
                children: checking ? "Проверяю…" : "Проверить подключение",
              }),
            ],
          }),
          checkLine,
          jsx("datalist", {
            id: WIZARD_PLATFORM_LIST,
            children: platforms.map((p) => jsx("option", { key: p.path, value: p.path, children: p.version })),
          }),
          jsx("datalist", {
            id: WIZARD_INFOBASE_LIST,
            children: infoBases.map((b) => jsx("option", { key: b.value, value: b.value, children: b.name })),
          }),
        ],
      });

      const stepRules = jsx(Card, {
        title: "Правила 1С в проекте",
        hint: jsxs("span", {
          children: [
            "Наши правила и плейбуки разворачиваются всегда. Дерево ",
            jsx("a", {
              className: "p1c-link",
              href: (rulesSet && rulesSet.repo) || RULES_REPO,
              target: "_blank",
              rel: "noreferrer",
              children: "comol",
            }),
            " можно добавить к ним флажком.",
          ],
        }),
        children: jsxs("div", {
          className: "p1c-stack",
          children: [
            jsx(RulesetPicker, {
              sets: rulesets,
              value: rulesBase,
              disabled: busy,
              onChange: (id) => setRulesOptions((options) => ({ ...options, base: id })),
            }),
            rulesSet && rulesSet.available
              ? null
              : jsx("div", {
                  className: "p1c-note",
                  children: "Правила comol не найдены в DSH — развернутся только наши правила.",
                }),
            rulesBase === "comol"
              ? jsxs("div", {
                  className: "p1c-options",
                  children: [
                    jsx(Check, {
                      checked: rulesOptions.useEdt,
                      disabled: busy,
                      onChange: (event) => setRulesOptions((o) => ({ ...o, useEdt: event.target.checked })),
                      title: "В EDT другой набор исходников — ссылки в правилах переписываются под его структуру",
                      children: "проект ведётся в 1С:EDT (другая структура исходников)",
                    }),
                    jsx(Check, {
                      checked: rulesOptions.includePassword,
                      disabled: busy,
                      title: "Записать пароль базы в .dev.env (по умолчанию не переносится: файл часто попадает в git)",
                      onChange: (event) => setRulesOptions((o) => ({ ...o, includePassword: event.target.checked })),
                      children: "записать пароль базы в .dev.env",
                    }),
                  ],
                })
              : null,
            jsx("div", {
              className: "p1c-actions",
              children: jsx(Btn, {
                variant: "primary",
                disabled: busy,
                onClick: deployRules,
                children: "Развернуть правила",
              }),
            }),
            jsx(RulesReport, { result: rulesResult }),
          ],
        }),
      });

      const dumpCard = jsx(Card, {
        title: "Выгрузка конфигурации",
        hint: "Конфигуратор выгружает конфигурацию базы в XML-файлы. Пока идёт операция, база занята.",
        children: jsxs("div", {
          className: "p1c-stack",
          children: [
            jsxs("div", {
              className: "p1c-grid",
              children: [
                jsx(Field, {
                  htmlFor: "p1c-wizard-dumpdir",
                  label: "Каталог выгрузки",
                  hint: "Пусто — корень проекта.",
                  children: jsx("input", {
                    id: "p1c-wizard-dumpdir",
                    className: "p1c-input",
                    value: form.dumpDir,
                    placeholder: "пусто — корень проекта",
                    onChange: (e) => setForm((f) => ({ ...f, dumpDir: e.target.value })),
                  }),
                }),
                jsx("div", {
                  className: "p1c-field p1c-field--format",
                  children: [
                    jsx("label", { className: "p1c-label", htmlFor: "p1c-wizard-format", children: "Формат выгрузки" }),
                    jsxs("select", {
                      id: "p1c-wizard-format",
                      className: "p1c-select",
                      value: runOptions.format,
                      disabled: running,
                      onChange: (e) => setRunOptions((o) => ({ ...o, format: e.target.value })),
                      children: [
                        jsx("option", { value: "Hierarchical", children: "иерархический" }),
                        jsx("option", { value: "Plain", children: "плоский" }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            jsxs("div", {
              className: "p1c-options",
              children: [
                jsx(Check, {
                  checked: runOptions.update,
                  disabled: running,
                  title: "Выгружать только изменившиеся объекты (DESIGNER -update -force)",
                  onChange: (e) => setRunOptions((o) => ({ ...o, update: e.target.checked })),
                  children: "только изменения",
                }),
                jsx(Check, {
                  checked: runOptions.cleanLocks,
                  disabled: running,
                  title: "Удалить lock-файлы .cfl файловой базы перед запуском",
                  onChange: (e) => setRunOptions((o) => ({ ...o, cleanLocks: e.target.checked })),
                  children: "снять .cfl перед запуском",
                }),
              ],
            }),
            jsxs("div", {
              className: "p1c-actions",
              children: [
                running
                  ? jsx(Btn, { variant: "danger", disabled: busy, onClick: cancelDump, children: "Отменить выгрузку" })
                  : jsx(Btn, {
                      variant: "primary",
                      disabled: locked || !canRun,
                      title: "DESIGNER /DumpConfigToFiles — выгрузить конфигурацию в файлы",
                      onClick: startDump,
                      children: "Выгрузить в файлы",
                    }),
                !canRun
                  ? jsx("span", {
                      className: "p1c-note",
                      children: form.infobasePath
                        ? "Путь к базе введён, но не сохранён — нажмите «Назад» и «Далее» на шаге с базой."
                        : "Сначала укажите путь к базе на шаге «База 1С».",
                    })
                  : null,
              ],
            }),
            job && job.state !== "idle" && job.path === target.path
              ? jsxs("div", {
                  className: "p1c-stack p1c-stack--tight",
                  children: [
                    jsx(JobBox, { job }),
                    job.log && job.state !== "running"
                      ? jsxs("details", {
                          className: "p1c-details",
                          children: [
                            jsx(Summary, { children: "Лог Конфигуратора" }),
                            jsx("pre", { className: "p1c-log", children: job.log }),
                          ],
                        })
                      : null,
                  ],
                })
              : null,
          ],
        }),
      });

      // Индекс rlm — рядом с выгрузкой, а не на странице итога: он нужен, когда
      // исходники уже в проекте, и это отдельная работа, а не строка сводки.
      const rlmCard = jsx(Card, {
        title: "Синтаксическая индексация",
        children: jsxs("div", {
          className: "p1c-stack",
          children: [
            jsx(Check, {
              checked: indexRlm,
              onChange: (event) => setIndexRlm(event.target.checked),
              children: "индексировать проект",
            }),
            jsx(Field, {
              wide: true,
              htmlFor: "p1c-wizard-rlm-path",
              label: "Папка выгрузки",
              hint: "Что индексировать. Пусто — папка проекта.",
              children: jsx("input", {
                id: "p1c-wizard-rlm-path",
                className: "p1c-input",
                value: indexPath,
                placeholder: target.path,
                onChange: (event) => setIndexPath(event.target.value),
              }),
            }),
          ],
        }),
      });

      const stepDump = jsxs("div", {
        className: "p1c-stack",
        children: [dumpCard, rlmCard],
      });

      const effectivePlatform = form.platformPath || commonPlatform;
      const rulesSummary = rulesResult && rulesResult.ok
        ? "развёрнуты: " + ((rulesSet && rulesSet.title) || rulesBase)
        : detect && detect.hasRules
          ? "уже были в проекте"
          : "не развёрнуты";
      const connected = Boolean(connection && connection.ok);
      const dumpSummary = job && job.operation === "dump" && job.state === "done"
        ? "выгружена" + (job.files ? ", файлов " + job.files : "")
        : detect && detect.hasDump
          ? "в проекте есть"
          : "не делалась";

      const platformCtx = (state && state.platformContext) || null;
      const mcpRows = [];
      if (platformCtx) {
        mcpRows.push(
          jsx(Row, {
            key: "platform-context",
            label: "Справка по API платформы",
            value: platformCtx.indexLoaded
              ? "подключена"
              : platformCtx.running
                ? "запущена, индекс платформы не собран"
                : platformCtx.pathMissing
                  ? "не подключена: путь к платформе не задан"
                  : "не подключена",
            tone: platformCtx.indexLoaded ? undefined : "warn",
          }),
        );
      }
      // Серверы — одной строкой, а не по строке на сервер: иначе итоговый шаг
      // растёт вместе с бандлом и окно визарда приходится прокручивать.
      const enabledServers = [];
      const disabledServers = [];
      for (const server of mcp && mcp.available ? mcp.servers : []) {
        if (server.name === "1c-platform-context") continue;
        (server.enabled ? enabledServers : disabledServers).push(server.name);
      }
      if (enabledServers.length > 0 || disabledServers.length > 0) {
        mcpRows.push(
          jsx(Row, {
            key: "mcp-servers",
            label: "Серверы бандла",
            value: [
              enabledServers.length > 0 ? enabledServers.join(", ") : "все выключены",
              disabledServers.length > 0 ? "выключены: " + disabledServers.join(", ") : "",
            ]
              .filter(Boolean)
              .join(" · "),
            tone: enabledServers.length > 0 ? undefined : "warn",
          }),
        );
      }

      const stepDone = jsxs("div", {
        className: "p1c-stack",
        children: [
          jsx(Card, {
            title: "Что настроено",
            children: jsxs("div", {
              className: "p1c-rows",
              children: [
                jsx(Row, { label: "База 1С", value: form.infobasePath || "не указана" }),
                jsx(Row, { label: "Подключение", value: connected ? "проверено" : "не проверялось" }),
                jsx(Row, { label: "Платформа", value: effectivePlatform || "не задана" }),
                jsx(Row, { label: "Навыки 1С", value: rulesSummary }),
                jsx(Row, { label: "Выгрузка", value: dumpSummary }),
                jsx(Row, { label: "Синтаксическая индексация", value: indexRlm ? "включена" : "выключена" }),
              ],
            }),
          }),
          mcpRows.length
            ? jsx(Card, {
                title: "Серверы MCP",
                hint: "Общие для приложения: работают во всех проектах и переключаются в панели MCP.",
                children: jsx("div", { className: "p1c-rows", children: mcpRows }),
              })
            : null,
          jsx(Card, {
            title: "Где это лежит",
            children: jsx("div", {
              className: "p1c-note",
              children: "Параметры — .dsh/1c-project.json. Изменить позже: Настройки → 1С: Параметры проектов.",
            }),
          }),
        ],
      });

      // Проверки кода — отдельный шаг: включение это решение, а не деталь
      // выгрузки, и по умолчанию оно не запускает ни одной проверки.
      const stepChecks = jsx(ChecksCard, { path: target.path });

      const bodyByStep = [stepKind, stepBase, stepRules, stepDump, stepChecks, stepDone];
      const stepNames = ["Проект 1С", "База и платформа", "Навыки", "Выгрузка", "Анализ кода 1С", "Готово"];
      const WIZARD_STEPS = bodyByStep.length;

      const stepsBar = jsx("div", {
        className: "p1c-steps",
        role: "progressbar",
        "aria-valuemin": 1,
        "aria-valuemax": WIZARD_STEPS,
        "aria-valuenow": step + 1,
        children: stepNames.map((name, index) =>
          jsxs("div", {
            key: name,
            className: cx("p1c-step", index < step && "is-done", index === step && "is-current"),
            children: [
              jsx("span", { className: "p1c-step__bar", title: name }),
              jsx("span", { className: "p1c-step__label", children: name }),
            ],
          }),
        ),
      });

      const primaryButton = (() => {
        if (step === 0) {
          return jsx(Btn, {
            variant: "primary",
            disabled: is1c === null,
            onClick: () => (is1c ? setStep(1) : onClose()),
            children: is1c === false ? "Готово" : "Далее",
          });
        }
        if (step === 1) {
          return jsx(Btn, { variant: "primary", disabled: busy, onClick: submitBase, children: "Далее" });
        }
        if (step === 2) {
          return jsx(Btn, { variant: "primary", onClick: () => setStep(3), children: "Далее" });
        }
        if (step === 3) {
          return jsx(Btn, {
            variant: "primary",
            disabled: running || busy,
            title: running ? "Дождитесь окончания выгрузки" : undefined,
            onClick: leaveDump,
            children: "Далее",
          });
        }
        if (step === 4) {
          return jsx(Btn, { variant: "primary", onClick: () => setStep(5), children: "Далее" });
        }
        return jsx(Btn, { variant: "primary", disabled: busy, onClick: finishWizard, children: "Готово" });
      })();

      return portal(
        jsxs("div", {
          className: "p1c-root p1c-overlay",
          children: [
            jsx("div", { className: "p1c-mask", onClick: onClose, "aria-hidden": "true" }),
            jsxs("div", {
              className: "p1c-dialog",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": "Настройка проекта 1С",
              children: [
                jsxs("div", {
                  className: "p1c-dialog__head",
                  children: [
                    jsxs("div", {
                      className: "p1c-dialog__headmain",
                      children: [
                        jsx("div", { className: "p1c-dialog__title", children: "Настройка проекта 1С" }),
                        jsx("div", { className: "p1c-dialog__project", children: target.title }),
                        jsx("div", { className: "p1c-dialog__path p1c-mono", title: target.path, children: target.path }),
                      ],
                    }),
                    jsx(Btn, { variant: "icon", title: "Закрыть", onClick: onClose, children: jsx(CloseIcon, {}) }),
                  ],
                }),
                jsxs("div", {
                  className: "p1c-dialog__body p1c-dialog__body--wizard",
                  children: [stepsBar, statusLine, bodyByStep[step]],
                }),
                jsxs("div", {
                  className: "p1c-dialog__foot",
                  children: [
                    jsxs("div", {
                      className: "p1c-dialog__footleft",
                      children: [step > 0 ? jsx(Btn, { disabled: locked, onClick: () => setStep(step - 1), children: "Назад" }) : null],
                    }),
                    jsx("div", { className: "p1c-dialog__footright", children: primaryButton }),
                  ],
                }),
              ],
            }),
          ],
        }),
      );
    }

    /** Модальное окно параметров одного проекта. */
    function ProjectDialog(props) {
      const {
        project,
        state,
        form,
        setForm,
        showPassword,
        setShowPassword,
        runOptions,
        setRunOptions,
        loadOptions,
        setLoadOptions,
        job,
        opError,
        busy,
        infoBaseHint,
        platformPlaceholder,
        infoBases,
        platforms,
        rulesets,
        rulesSelected,
        rulesDeployed,
        onRulesSelect,
        rulesResult,
        rulesOptions,
        setRulesOptions,
        onRulesDeploy,
        onSave,
        onClear,
        onForget,
        onStartDump,
        onStartLoad,
        onStartExtensions,
        onCancelDump,
        onClose,
      } = props;

      injectStyles();

      // Escape закрывает окно и НЕ закрывает настройки: перехватываем на фазе
      // перехвата, пока обработчик панели настроек (bubble) не сработал.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
      }, [onClose]);

      const running = Boolean(job && job.state === "running");
      const jobIsHere = Boolean(job && job.path === project.path);
      const operationsLocked = busy || running;
      const canRun = Boolean(project.params.infobasePath);

      // ── прогресс операции ─────────────────────────────────────────────────
      const jobBlock = job && jobIsHere && job.state !== "idle"
        ? jsxs("div", {
            className: "p1c-stack p1c-stack--tight",
            children: [
              jsx(JobBox, { job }),
              job.log && job.state !== "running"
                ? jsxs("details", {
                    className: "p1c-details",
                    children: [
                      jsx(Summary, { children: "Лог Конфигуратора" }),
                      jsx("pre", { className: "p1c-log", children: job.log }),
                    ],
                  })
                : null,
            ],
          })
        : null;

      // ── блок правил 1С ─────────────────────────────────────────────────────
      // Подпись кнопки зависит от того, что уже лежит в проекте: набора нет —
      // «Развернуть», тот же набор — «Обновить», другой — «Сменить набор…».
      const rulesDeployedFlag = Boolean(rulesDeployed && rulesDeployed.deployed);
      const deployedWithComol = Boolean(rulesDeployedFlag && rulesDeployed.withComol);
      const rulesActionLabel = !rulesDeployedFlag
        ? "Развернуть"
        : deployedWithComol === (rulesSelected === "comol")
          ? "Обновить"
          : "Применить";
      const rulesActionTitle = !rulesDeployedFlag
        ? "Разложить наши правила в проект"
        : "Обновить файлы правил";
      const deployedLine = rulesDeployedFlag
        ? "Развёрнуто: наши правила" + (deployedWithComol ? " + comol" : "")
        : "";

      const rulesResultBlock = rulesResult
        ? jsxs("details", {
            className: "p1c-details",
            open: true,
            children: [
              jsx(Summary, { children: "Результат последнего запуска" }),
              jsx("div", { className: "p1c-details__body", children: jsx(RulesReport, { result: rulesResult }) }),
            ],
          })
        : null;

      return portal(jsxs("div", {
        className: "p1c-root p1c-overlay",
        children: [
          jsx("div", { className: "p1c-mask", onClick: onClose, "aria-hidden": "true" }),
          jsxs("div", {
            className: "p1c-dialog",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": "Параметры проекта " + project.title,
            children: [
              jsxs("div", {
                className: "p1c-dialog__head",
                children: [
                  jsxs("div", {
                    className: "p1c-dialog__headmain",
                    children: [
                      jsx("div", { className: "p1c-dialog__title", children: "Параметры проекта" }),
                      jsx("div", { className: "p1c-dialog__project", children: project.title }),
                      jsx("div", { className: "p1c-dialog__path p1c-mono", title: project.path, children: project.path }),
                    ],
                  }),
                  jsx(Btn, {
                    variant: "icon",
                    title: "Закрыть",
                    onClick: onClose,
                    children: jsx(CloseIcon, {}),
                  }),
                ],
              }),
              jsxs("div", {
                className: "p1c-dialog__body p1c-dialog__body--project",
                children: [
                  jsx(Card, {
                    title: "Подключение",
                    hint: "Значения проекта лежат в " + state.paramsRel + " внутри его папки — их видно в git и можно править руками.",
                    children: jsxs("div", {
                      className: "p1c-grid",
                      children: [
                        jsx(Field, {
                          wide: true,
                          htmlFor: "p1c-infobase",
                          label: "Путь к базе",
                          hint: infoBaseHint,
                          children: jsx("input", {
                            id: "p1c-infobase",
                            className: "p1c-input",
                            list: INFOBASE_LIST_ID,
                            autoFocus: true,
                            value: form.infobasePath,
                            placeholder: 'C:\\Базы\\Бухгалтерия  либо  Srvr="server";Ref="buh";',
                            onChange: (e) => setForm((f) => ({ ...f, infobasePath: e.target.value })),
                          }),
                        }),
                        jsx(Field, {
                          htmlFor: "p1c-user",
                          label: "Пользователь",
                          children: jsx("input", {
                            id: "p1c-user",
                            className: "p1c-input",
                            value: form.user,
                            onChange: (e) => setForm((f) => ({ ...f, user: e.target.value })),
                          }),
                        }),
                        jsx(Field, {
                          htmlFor: "p1c-password",
                          label: "Пароль",
                          labelExtra: jsx(Check, {
                            compact: true,
                            checked: showPassword,
                            onChange: (e) => setShowPassword(e.target.checked),
                            children: "показать",
                          }),
                          hint: "Хранится открытым текстом — не коммитьте файл параметров.",
                          children: jsx("input", {
                            id: "p1c-password",
                            className: "p1c-input",
                            type: showPassword ? "text" : "password",
                            value: form.password,
                            onChange: (e) => setForm((f) => ({ ...f, password: e.target.value })),
                          }),
                        }),
                        jsx(Field, {
                          wide: true,
                          htmlFor: "p1c-platform",
                          label: "Путь к платформе 1С",
                          hint: form.platformPath
                            ? "Путь задан для этого проекта."
                            : "Пусто — берётся общее значение: " + (state.common.platformPath || "не задано"),
                          children: jsx("input", {
                            id: "p1c-platform",
                            className: "p1c-input",
                            list: PLATFORM_LIST_ID,
                            value: form.platformPath,
                            placeholder: platformPlaceholder,
                            onChange: (e) => setForm((f) => ({ ...f, platformPath: e.target.value })),
                          }),
                        }),
                        jsx(Field, {
                          htmlFor: "p1c-unlock",
                          label: "Код доступа к базе",
                          hint: "Нужен, если на базе стоит блокировка соединений (/UC).",
                          children: jsx("input", {
                            id: "p1c-unlock",
                            className: "p1c-input",
                            value: form.unlockCode,
                            placeholder: "пусто — без кода",
                            onChange: (e) => setForm((f) => ({ ...f, unlockCode: e.target.value })),
                          }),
                        }),
                        jsx(Field, {
                          htmlFor: "p1c-dumpdir",
                          label: "Каталог выгрузки",
                          hint: "Куда писать XML: абсолютный путь или путь внутри проекта.",
                          children: jsx("input", {
                            id: "p1c-dumpdir",
                            className: "p1c-input",
                            value: form.dumpDir,
                            placeholder: "пусто — корень проекта",
                            onChange: (e) => setForm((f) => ({ ...f, dumpDir: e.target.value })),
                          }),
                        }),
                      ],
                    }),
                  }),

                  jsx(Card, {
                    title: "Выгрузка и загрузка конфигурации",
                    hint: "Конфигуратор блокирует конфигурацию базы: одновременно выполняется одна операция.",
                    children: jsxs("div", {
                      className: "p1c-stack",
                      children: [
                        jsxs("div", {
                          className: "p1c-field p1c-field--format",
                          children: [
                            jsx("label", { className: "p1c-label", htmlFor: "p1c-dump-format", children: "Формат выгрузки" }),
                            jsxs("select", {
                              id: "p1c-dump-format",
                              className: "p1c-select",
                              value: runOptions.format,
                              disabled: running && jobIsHere,
                              onChange: (e) => setRunOptions((o) => ({ ...o, format: e.target.value })),
                              children: [
                                jsx("option", { value: "Hierarchical", children: "иерархический" }),
                                jsx("option", { value: "Plain", children: "плоский" }),
                              ],
                            }),
                          ],
                        }),
                        jsxs("div", {
                          className: "p1c-options",
                          children: [
                            jsx(Check, {
                              checked: runOptions.update,
                              disabled: running && jobIsHere,
                              title: "Выгружать только изменившиеся объекты (DESIGNER -update -force)",
                              onChange: (e) => setRunOptions((o) => ({ ...o, update: e.target.checked })),
                              children: "только изменения",
                            }),
                            jsx(Check, {
                              checked: runOptions.cleanLocks,
                              disabled: running && jobIsHere,
                              title: "Удалить lock-файлы .cfl файловой базы перед запуском",
                              onChange: (e) => setRunOptions((o) => ({ ...o, cleanLocks: e.target.checked })),
                              children: "снять .cfl перед запуском",
                            }),
                          ],
                        }),
                        jsxs("div", {
                          className: "p1c-actions",
                          children: [
                            running && jobIsHere
                              ? jsx(Btn, { variant: "danger", disabled: busy, onClick: onCancelDump, children: "Отменить операцию" })
                              : jsx(Btn, {
                                  variant: "primary",
                                  disabled: operationsLocked || !canRun,
                                  title: "DESIGNER /DumpConfigToFiles — выгрузить конфигурацию в файлы",
                                  onClick: onStartDump,
                                  children: "Выгрузить в файлы",
                                }),
                            // Кнопки видны всегда: скрывать их до сохранения пути к базе
                            // значит прятать половину возможностей плагина. Недоступность
                            // объясняет подпись ниже, а не исчезновение кнопки.
                            jsx(Btn, {
                              variant: "primary",
                              disabled: operationsLocked || !canRun,
                              onClick: onStartLoad,
                              title: "DESIGNER /LoadConfigFromFiles — загрузить конфигурацию из каталога выгрузки в базу",
                              children: "Загрузить из файлов",
                            }),
                            jsx(Btn, {
                              variant: "primary",
                              disabled: operationsLocked || !canRun,
                              onClick: onStartExtensions,
                              title: "DESIGNER /DumpConfigToFiles -AllExtensions — выгрузить все расширения базы в исходники",
                              children: "Выгрузить расширения",
                            }),
                            !canRun
                              ? jsx("span", {
                                  className: "p1c-note",
                                  children: form.infobasePath
                                    ? "Путь к базе введён, но не сохранён — нажмите «Сохранить»."
                                    : "Сначала укажите путь к базе и нажмите «Сохранить».",
                                })
                              : null,
                          ],
                        }),
                        opError
                          ? jsx("div", { className: "p1c-note p1c-note--err", children: opError })
                          : null,
                        jsxs("div", {
                          className: "p1c-stack p1c-stack--tight",
                          children: [
                            jsxs("div", {
                              className: "p1c-options",
                              children: [
                                jsx(Check, {
                                  checked: loadOptions.updateDb,
                                  disabled: running && jobIsHere,
                                  title: "DESIGNER /UpdateDBCfg",
                                  onChange: (e) => setLoadOptions((o) => ({ ...o, updateDb: e.target.checked })),
                                  children: "обновить конфигурацию базы данных",
                                }),
                                jsx(Check, {
                                  checked: loadOptions.dynamic,
                                  disabled: (running && jobIsHere) || !loadOptions.updateDb,
                                  title: "DESIGNER -Dynamic+ -SessionTerminate force",
                                  onChange: (e) => setLoadOptions((o) => ({ ...o, dynamic: e.target.checked })),
                                  children: "динамически, без выхода пользователей",
                                }),
                              ],
                            }),
                            jsx("div", {
                              className: "p1c-note",
                              children: loadOptions.updateDb
                                ? loadOptions.dynamic
                                  ? "Загрузка заменит конфигурацию базы; обновление пойдёт динамически — сеансы не прерываются, но структурные изменения могут потребовать нединамического обновления."
                                  : "Загрузка заменит конфигурацию базы; нединамическое обновление требует выхода всех пользователей."
                                : "Конфигурация базы не обновится: изменения останутся только в конфигурации (для применения нужен отдельный вызов /UpdateDBCfg).",
                            }),
                            jsx("div", {
                              className: "p1c-note",
                              children: "Источник — каталог выгрузки: " + (form.dumpDir || "корень проекта") +
                                ". Каталог без Configuration.xml плагин грузить откажется; расширения идут в подпапку Extensions.",
                            }),
                          ],
                        }),
                        jobBlock,
                      ],
                    }),
                  }),

                  jsx(Card, {
                    title: "Правила 1С в проекте",
                    children: jsxs("div", {
                      className: "p1c-stack",
                      children: [
                        jsx(RulesetPicker, {
                          sets: rulesets,
                          value: rulesSelected,
                          disabled: busy,
                          onChange: onRulesSelect,
                        }),
                        rulesSelected === "comol"
                          ? jsxs("div", {
                              className: "p1c-options",
                              children: [
                                jsx(Check, {
                                  checked: rulesOptions.useEdt,
                                  disabled: busy,
                                  onChange: (event) => setRulesOptions((o) => ({ ...o, useEdt: event.target.checked })),
                                  children: "в проекте используется 1С:EDT",
                                }),
                                jsx(Check, {
                                  checked: rulesOptions.includePassword,
                                  disabled: busy,
                                  title: "Записать пароль базы в .dev.env (по умолчанию не переносится: файл часто попадает в git)",
                                  onChange: (event) => setRulesOptions((o) => ({ ...o, includePassword: event.target.checked })),
                                  children: "записать пароль базы в .dev.env",
                                }),
                              ],
                            })
                          : null,
                        jsxs("div", {
                          className: "p1c-actions",
                          children: [
                            jsx(Btn, {
                              variant: "primary",
                              disabled: busy,
                              title: rulesActionTitle,
                              onClick: onRulesDeploy,
                              children: rulesActionLabel,
                            }),
                            jsx("span", { className: "p1c-note", children: deployedLine }),
                          ],
                        }),
                        rulesResultBlock,
                      ],
                    }),
                  }),
                  jsx(RlmIndexCard, { path: project.path }),
                  jsx(ChecksCard, { path: project.path }),
                ],
              }),
              jsxs("div", {
                className: "p1c-dialog__foot",
                children: [
                  jsxs("div", {
                    className: "p1c-dialog__footleft",
                    children: [
                      jsx(Btn, {
                        variant: "danger",
                        disabled: busy || !project.hasFile,
                        title: "Удалить " + project.filePath,
                        onClick: onClear,
                        children: "Удалить файл",
                      }),
                      project.source === "extra"
                        ? jsx(Btn, { variant: "danger", disabled: busy, onClick: onForget, children: "Убрать из списка" })
                        : null,
                    ],
                  }),
                  jsxs("div", {
                    className: "p1c-dialog__footright",
                    children: [
                      jsx(Btn, { onClick: onClose, children: "Закрыть" }),
                      jsx(Btn, { variant: "primary", disabled: busy, onClick: onSave, children: "Сохранить" }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }));
    }

    function Section() {
      const [state, setState] = useState(null);
      const [openPath, setOpenPath] = useState(null);
      const [form, setForm] = useState(EMPTY_FORM);
      const [commonPlatform, setCommonPlatform] = useState("");
      const [showPassword, setShowPassword] = useState(false);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [newPath, setNewPath] = useState("");
      const [job, setJob] = useState(null);
      const [runOptions, setRunOptions] = useState(EMPTY_RUN);
      const [loadOptions, setLoadOptions] = useState(EMPTY_LOAD);
      const [rulesResult, setRulesResult] = useState(null);
      const [rulesOptions, setRulesOptions] = useState(EMPTY_RULES_OPTIONS);
      const [opError, setOpError] = useState(null);
      const [platformCtx, setPlatformCtx] = useState(null);

      injectStyles();

      const load = useCallback(async () => {
        try {
          const data = await request("/state");
          setState(data);
          setCommonPlatform(data.common ? data.common.platformPath || "" : "");
          setPlatformCtx(data.platformContext || null);
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const project = state && openPath ? state.projects.find((p) => p.path === openPath) || null : null;
      // Движок поднимается отдельно от параметров проекта: его отказ должен быть назван на этой
      // странице, а не всплывать 404-м в карточке индекса.
      const engineNotice =
        state && state.engineError
          ? jsxs("div", {
              className: "p1c-note p1c-note--warn",
              children: [
                "Движок rlm-tools-bsl не поднялся: ",
                String(state.engineError),
                ". Параметры проекта работают, индексы и MCP-сервер — нет. Если в профиле остался старый плагин dsh-rlm-tools-bsl, удалите его: он владеет теми же маршрутами.",
              ],
            })
          : null;

      useEffect(() => {
        if (!project) {
          setForm(EMPTY_FORM);
          return;
        }
        setForm({
          infobasePath: project.params.infobasePath || "",
          user: project.params.user || "",
          password: project.params.password || "",
          platformPath: project.params.platformPath || "",
          unlockCode: project.params.unlockCode || "",
          dumpDir: project.params.dumpDir || "",
        });
        setShowPassword(false);
      }, [state, openPath]);

      const run = async (action, message) => {
        setBusy(true);
        try {
          const result = await action();
          setStatus({ kind: "ok", text: message });
          return result;
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
          return null;
        } finally {
          setBusy(false);
        }
      };

      /** Отказ операции Конфигуратора показываем в карточке, а не только в строке статуса. */
      const recordOpError = (error) => {
        setOpError(String((error && error.message) || error));
        throw error;
      };

      const saveCommon = () =>
        run(async () => {
          await request("/common", { method: "POST", body: JSON.stringify({ platformPath: commonPlatform }) });
          await load();
        }, "Общие настройки сохранены");

      // Перезапуск сервера справки: индекс платформы собирается при старте,
      // поэтому ответ приходит не мгновенно — на это время кнопка занята.
      const restartPlatformContext = () =>
        run(async () => {
          try {
            await request("/platform-context-restart", { method: "POST" });
          } finally {
            await load();
          }
        }, "Сервер справки перезапущен");

      const saveProject = () => {
        if (!project) return;
        run(async () => {
          await request("/project-save", { method: "POST", body: JSON.stringify({ path: project.path, params: form }) });
          await load();
        }, "Параметры проекта сохранены");
      };

      const clearProject = () => {
        if (!project) return;
        const question = "Удалить файл " + state.paramsRel + " у проекта «" + project.title + "»?";
        if (typeof window !== "undefined" && !window.confirm(question)) return;
        run(async () => {
          await request("/project-clear", { method: "POST", body: JSON.stringify({ path: project.path }) });
          await load();
        }, "Файл параметров удалён");
      };

      const forgetProject = () => {
        if (!project) return;
        run(async () => {
          await request("/project-forget", { method: "POST", body: JSON.stringify({ path: project.path }) });
          setOpenPath(null);
          await load();
        }, "Проект убран из списка");
      };

      const addProject = () => {
        const path = newPath.trim();
        if (!path) return;
        run(async () => {
          const data = await request("/project-add", { method: "POST", body: JSON.stringify({ path }) });
          setNewPath("");
          setOpenPath(data.path);
          await load();
        }, "Проект добавлен в список");
      };

      // ── выгрузка конфигурации в файлы ──────────────────────────────────────
      const refreshJob = useCallback(async () => {
        try {
          const data = await request("/dump-status");
          setJob(data.job);
        } catch {}
      }, []);

      useEffect(() => {
        refreshJob();
      }, [refreshJob]);

      useEffect(() => {
        if (!job || job.state !== "running") return;
        const timer = setInterval(refreshJob, 2000);
        return () => clearInterval(timer);
      }, [job && job.state, refreshJob]);

      const startDump = () => {
        if (!project) return;
        setOpError(null);
        run(async () => {
          const data = await request("/dump-start", {
            method: "POST",
            body: JSON.stringify({
              path: project.path,
              dir: form.dumpDir,
              format: runOptions.format,
              update: runOptions.update,
              cleanLocks: runOptions.cleanLocks,
            }),
          }).catch(recordOpError);
          setJob(data.job);
        }, "Выгрузка запущена");
      };

      const cancelDump = () =>
        run(async () => {
          const data = await request("/dump-cancel", { method: "POST", body: JSON.stringify({ path: project ? project.path : "" }) });
          setJob(data.job);
        }, "Операция отменена");

      // Обратная загрузка конфигурации: заменяет конфигурацию базы, поэтому
      // подтверждение обязательно и с прямым перечислением последствий.
      const startLoad = () => {
        if (!project) return;
        const dir = form.dumpDir || "корень проекта";
        const question =
          "Загрузить конфигурацию из файлов в базу проекта «" + project.title + "»?\n\n" +
          "Источник: " + dir + " (файл Configuration.xml в нём обязателен).\n" +
          "Текущая конфигурация базы будет заменена содержимым каталога — отменить это нельзя.\n" +
          (loadOptions.updateDb
            ? (loadOptions.dynamic
              ? "Конфигурация базы будет обновлена динамически."
              : "ВНИМАНИЕ: нединамическое обновление требует выхода всех пользователей из базы.")
            : "Конфигурация базы обновляться не будет.");
        if (typeof window !== "undefined" && !window.confirm(question)) return;
        setOpError(null);
        run(async () => {
          const data = await request("/load-start", {
            method: "POST",
            body: JSON.stringify({
              path: project.path,
              dir: form.dumpDir,
              format: runOptions.format,
              updateDb: loadOptions.updateDb,
              dynamic: loadOptions.dynamic,
              cleanLocks: runOptions.cleanLocks,
            }),
          }).catch(recordOpError);
          setJob(data.job);
        }, "Загрузка запущена");
      };

      // Расширения кладём отдельной папкой рядом с конфигурацией: -AllExtensions
      // в общем каталоге смешал бы объекты расширений с объектами конфигурации.
      const startExtensions = () => {
        if (!project) return;
        const dir = form.dumpDir ? form.dumpDir + "\\Extensions" : "корень проекта\\Extensions";
        const question =
          "Выгрузить все расширения базы проекта «" + project.title + "» в исходники?\n\n" +
          "Каталог: " + dir + "\n" +
          "Конфигуратор выполнит /DumpConfigToFiles с ключом -AllExtensions. " +
          "Существующие исходники расширений в этом каталоге будут перезаписаны.";
        if (typeof window !== "undefined" && !window.confirm(question)) return;
        setOpError(null);
        run(async () => {
          const data = await request("/extensions-start", {
            method: "POST",
            body: JSON.stringify({ path: project.path, dir: form.dumpDir, cleanLocks: runOptions.cleanLocks }),
          }).catch(recordOpError);
          setJob(data.job);
        }, "Выгрузка расширений запущена");
      };

      // ── правила 1С в проекте ───────────────────────────────────────────────
      useEffect(() => {
        setRulesResult(null);
        setRulesOptions({ ...EMPTY_RULES_OPTIONS });
      }, [openPath]);

      const rulesSets = readRulesets(state);
      const rulesDeployed = project && project.rules ? project.rules : null;
      const rulesDeployedWithComol = Boolean(
        rulesDeployed && rulesDeployed.deployed && rulesDeployed.withComol,
      );
      const rulesSelected = rulesOptions.base || (rulesDeployedWithComol ? "comol" : "");

      /** Разложить наши правила и, если стоит флажок, дерево comol. */
      const deployRulesTo = async () => {
        if (!project) return;
        setBusy(true);
        try {
          const result = await request("/rules-deploy", {
            method: "POST",
            body: JSON.stringify({
              path: project.path,
              withComol: rulesSelected === "comol",
              includePassword: rulesOptions.includePassword,
              useEdt: rulesOptions.useEdt,
            }),
          });
          setRulesResult(result);
          if (result && result.ok === true) {
            setStatus({ kind: "ok", text: "Правила развёрнуты в проект" });
            await load();
          }
        } catch (error) {
          setRulesResult({ ok: false, error: String((error && error.message) || error) });
        } finally {
          setBusy(false);
        }
      };

      const requestRulesDeploy = () => deployRulesTo();

      if (state === null) {
        return jsx("div", { className: "p1c-root", children: jsx("div", { className: "p1c-note", children: status ? status.text : "Загрузка параметров…" }) });
      }

      const projects = state.projects || [];
      const platforms = state.platforms || [];
      const infoBases = state.infobases || [];
      const platformPlaceholder = state.common.platformPath || "C:\\Program Files\\1cv8\\…\\bin\\1cv8.exe";
      const infoBaseHint = (() => {
        const parts = [
          infoBases.length
            ? "Найдено баз 1С: " + infoBases.length + " — поле подсказывает их при вводе."
            : "Список баз 1С (ibases.v8i) не найден — путь вводится вручную.",
        ];
        if (state.infobasesWebSkipped) parts.push("Через веб-сервер пропущено баз: " + state.infobasesWebSkipped + ".");
        return parts.join(" ");
      })();

      const statusLine = status
        ? jsxs("div", {
            className: "p1c-status",
            children: [
              jsx(Dot, { className: "p1c-status__dot", tone: status.kind === "ok" ? "ok" : "err" }),
              jsx("div", {
                className: cx("p1c-sm", status.kind === "ok" ? "p1c-text--ok" : "p1c-text--err"),
                children: status.text,
              }),
            ],
          })
        : null;

      const jobStrip = job && job.state !== "idle"
        ? jsx(JobBox, {
            job,
            showProject: true,
            actions: [
              state.projects.some((p) => p.path === job.path)
                ? jsx(Btn, { key: "open", onClick: () => setOpenPath(job.path), children: "Открыть" })
                : null,
              job.state === "running"
                ? jsx(Btn, { key: "cancel", variant: "danger", disabled: busy, onClick: cancelDump, children: "Отменить" })
                : null,
            ].filter(Boolean),
          })
        : null;

      // Платформенный контекст: сервер справки для агента. Показываем то, что
      // происходит на самом деле: путь может быть ещё не задан, и это не ошибка.
      const platformCtxCard = (() => {
        const info = platformCtx || {};
        const tone = info.indexLoaded ? "ok" : info.running ? "warn" : undefined;
        const label = info.pathMissing
          ? "Не запущен: путь к платформе не задан"
          : info.indexLoaded
            ? "Работает: справка отдаётся агенту"
            : info.running
              ? "Запущен, индекс платформы не собран"
              : "Не запущен";
        const stats = info.indexStats || {};
        const details = [
          info.platformError || "",
          info.error || "",
          info.indexLoaded
            ? "В индексе: типов " + (stats.types || 0) + ", перечислений " + (stats.enum_types || 0) + "."
            : "",
          info.url
            ? "Адрес: " + info.url + (info.managerRegistered ? " — отдан MCP-менеджеру." : " — менеджеру не отдан.")
            : "",
          info.version ? "Версия сервера: " + info.version + "." : "",
        ].filter(Boolean).join(" ");
        return jsx(Card, {
          title: "Платформенный контекст (MCP)",
          hint: "Справка по API установленной платформы для агента. Путь берётся из общих значений выше.",
          children: jsxs("div", {
            className: "p1c-field",
            children: [
              jsxs("div", {
                className: "p1c-label-row",
                children: [
                  jsxs("div", {
                    className: "p1c-status",
                    children: [
                      jsx(Dot, { className: "p1c-status__dot", tone }),
                      jsx("span", { className: "p1c-sm", children: label }),
                    ],
                  }),
                  jsx(Btn, {
                    disabled: busy || Boolean(info.pathMissing),
                    title: info.pathMissing ? "Сначала укажите путь к платформе в общих значениях" : undefined,
                    onClick: restartPlatformContext,
                    children: "Перезапустить",
                  }),
                ],
              }),
              details ? jsx("div", { className: "p1c-note", children: details }) : null,
            ],
          }),
        });
      })();

      const dialog = project
        ? jsx(ProjectDialog, {
            project,
            state,
            form,
            setForm,
            showPassword,
            setShowPassword,
            runOptions,
            setRunOptions,
            loadOptions,
            setLoadOptions,
            job,
            opError,
            busy,
            infoBaseHint,
            platformPlaceholder,
            infoBases,
            platforms,
            rulesets: rulesSets,
            rulesSelected,
            rulesDeployed,
            onRulesSelect: (id) => setRulesOptions((options) => ({ ...options, base: id })),
            rulesResult,
            rulesOptions,
            setRulesOptions,
            onRulesDeploy: requestRulesDeploy,
            onSave: saveProject,
            onClear: clearProject,
            onForget: forgetProject,
            onStartDump: startDump,
            onStartLoad: startLoad,
            onStartExtensions: startExtensions,
            onCancelDump: cancelDump,
            onClose: () => setOpenPath(null),
          })
        : null;

      return jsxs("div", {
        className: "p1c-root",
        children: [
          jsxs("div", {
            children: [
              jsx("div", { className: "p1c-title", children: "1С: Параметры проектов" }),
              jsx("div", {
                className: "p1c-subtitle",
                children: "Значения проекта лежат в " + state.paramsRel + " внутри его папки — их видно в git, можно править руками и читать другими инструментами.",
              }),
            ],
          }),
          statusLine,
          engineNotice,
          jobStrip,
          jsx(Card, {
            title: "Общие значения",
            hint: "Действуют для проектов, где своё значение не задано.",
            children: jsxs("div", {
              className: "p1c-field",
              children: [
                jsx("div", {
                  className: "p1c-label-row",
                  children: jsx("label", {
                    className: "p1c-label",
                    htmlFor: "p1c-common-platform",
                    children: "Путь к платформе 1С",
                  }),
                }),
                jsxs("div", {
                  className: "p1c-actions",
                  children: [
                    jsx("div", {
                      className: "p1c-actions__grow",
                      children: jsx("input", {
                        id: "p1c-common-platform",
                        className: "p1c-input",
                        list: PLATFORM_LIST_ID,
                        value: commonPlatform,
                        placeholder: "C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe",
                        onChange: (e) => setCommonPlatform(e.target.value),
                      }),
                    }),
                    jsx(Btn, { variant: "primary", disabled: busy, onClick: saveCommon, children: "Сохранить" }),
                  ],
                }),
                jsx("div", {
                  className: "p1c-note",
                  children: platforms.length
                    ? "Найдено платформ: " + platforms.length + " — начните вводить путь или выберите из списка."
                    : "Установленные платформы не найдены в стандартных каталогах — укажите путь вручную.",
                }),
              ],
            }),
          }),
          platformCtxCard,
          jsx(Card, {
            title: "Проекты (" + projects.length + ")",
            hint: "Параметры открываются по клику на проект.",
            children: jsxs("div", {
              className: "p1c-stack",
              children: [
                projects.length === 0
                  ? jsx("div", { className: "p1c-note", children: "В DSH не зарегистрировано ни одного воркспейса. Добавьте путь к папке проекта ниже." })
                  : jsxs("div", {
                      className: "p1c-stack p1c-stack--tight",
                      children: projects.map((p) =>
                        jsxs("button", {
                          key: p.path,
                          type: "button",
                          className: "p1c-project",
                          title: "Открыть параметры проекта",
                          onClick: () => setOpenPath(p.path),
                          children: [
                            jsxs("span", {
                              className: "p1c-project__main",
                              children: [
                                jsx("span", { className: "p1c-project__name", children: p.title }),
                                jsx("span", { className: "p1c-project__path p1c-mono", children: p.path }),
                              ],
                            }),
                            jsx(Dot, {
                              title: p.hasFile ? "Файл параметров есть" : "Файл параметров ещё не создан",
                              tone: p.hasFile ? "ok" : undefined,
                            }),
                            jsx("span", { className: "p1c-chevron", children: jsx(ChevronIcon, {}) }),
                          ],
                        }),
                      ),
                    }),
                jsxs("div", {
                  className: "p1c-actions",
                  children: [
                    jsx("div", {
                      className: "p1c-actions__grow",
                      children: jsx("input", {
                        className: "p1c-input",
                        value: newPath,
                        placeholder: "D:\\путь\\к\\проекту",
                        onChange: (e) => setNewPath(e.target.value),
                        onKeyDown: (e) => {
                          if (e.key === "Enter") addProject();
                        },
                      }),
                    }),
                    jsx(Btn, { disabled: busy || !newPath.trim(), onClick: addProject, children: "Добавить проект" }),
                  ],
                }),
              ],
            }),
          }),
          jsx("datalist", { id: PLATFORM_LIST_ID, children: platforms.map((p) => jsx("option", { key: p.path, value: p.path, children: p.version })) }),
          jsx("datalist", { id: INFOBASE_LIST_ID, children: infoBases.map((b) => jsx("option", { key: b.value, value: b.value, children: b.name })) }),
          dialog,
        ],
      });
    }

    // ── раздел движка rlm (раньше — отдельный плагин dsh-rlm-tools-bsl) ────────
    //
    // Статус MCP-сервера анализа кода 1С, перезапуск, порт и готовый JSON для
    // MCP-менеджера. Оформление и раскладка перенесены из того плагина как есть:
    // это отдельная вкладка настроек, а не часть параметров проекта.

    const rlmStyles = {
      input: {
        boxSizing: "border-box",
        width: 110,
        height: 30,
        padding: "0 8px",
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-base)",
        color: "inherit",
        font: "var(--dsw-font-s-14)",
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: 10,
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 10,
        padding: 14,
      },
      row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      subtitle: { opacity: 0.6, fontSize: 12, marginTop: 3, lineHeight: 1.5 },
      hint: { opacity: 0.55, fontSize: 11, lineHeight: 1.5 },
      path: { fontFamily: "monospace", fontSize: 11, opacity: 0.75, wordBreak: "break-all", userSelect: "text" },
      primaryButton: {
        flex: "0 0 auto",
        height: 30,
        padding: "0 14px",
        border: "none",
        borderRadius: 8,
        cursor: "pointer",
        background: "var(--dsw-alias-state-business-primary, #3964fe)",
        color: "#fff",
        font: "var(--dsw-font-s-14)",
      },
      secondaryButton: {
        flex: "0 0 auto",
        height: 30,
        padding: "0 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "inherit",
        font: "var(--dsw-font-s-14)",
      },
      snippet: {
        margin: 0,
        padding: "8px 10px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        background: "rgba(127,127,127,0.08)",
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 1.5,
        userSelect: "text",
      },
      log: {
        margin: "4px 0 0",
        maxHeight: 150,
        overflow: "auto",
        padding: "6px 8px",
        borderRadius: 8,
        background: "rgba(127,127,127,0.08)",
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        userSelect: "text",
      },
    };

    function rlmBadge(server) {
      if (server.installing) return { dot: "◌", color: "#e0a030", text: "устанавливается rlm-tools-bsl…" };
      if (server.starting) return { dot: "◌", color: "#e0a030", text: "запускается…" };
      if (server.stopping) return { dot: "◌", color: "#e0a030", text: "останавливается…" };
      // Процесс жив, но initialize не подтвердил версию: зелёный здесь врал бы.
      if ((server.managed || server.adopted) && server.lastError) {
        return { dot: "◌", color: "#e0a030", text: "запущен (pid " + server.pid + "), но не ответил на пробу" };
      }
      if (server.managed) return { dot: "●", color: "#4caf50", text: "работает (pid " + server.pid + (server.version ? ", v" + server.version : "") + ")" };
      if (server.adopted) return { dot: "●", color: "#4caf50", text: "работает — внешний процесс (pid " + server.pid + "), подхвачен при старте" };
      if (server.portOwner) return { dot: "▲", color: "#e57373", text: "порт " + server.portOwner.pid + " занят: " + (server.portOwner.image || "процесс") };
      return { dot: "○", color: "inherit", text: "остановлен" };
    }

    function RlmSection() {
      const [state, setState] = useState(null);
      const [port, setPort] = useState("");
      const [probeMin, setProbeMin] = useState("");
      const [jobMin, setJobMin] = useState("");
      const [dirty, setDirty] = useState(false);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        try {
          const data = await rlmRequest("/state");
          setState(data);
          return data;
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
          return null;
        }
      }, []);

      useEffect(() => {
        load();
        const timer = window.setInterval(load, 3000);
        return () => window.clearInterval(timer);
      }, [load]);

      useEffect(() => {
        if (!state || dirty) return;
        setPort(String(state.config.port || ""));
        const timeouts = state.indexTimeouts || {};
        setProbeMin(String(timeouts.probeMin || ""));
        setJobMin(String(timeouts.jobMin || ""));
      }, [state, dirty]);

      const run = async (action, message) => {
        setBusy(true);
        try {
          const result = await action();
          if (message) setStatus({ kind: "ok", text: message });
          return result;
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
          return null;
        } finally {
          setBusy(false);
          await load();
        }
      };

      const restart = () => run(() => rlmRequest("/restart", { method: "POST" }), "Сервер перезапущен");

      const savePort = () =>
        run(async () => {
          const result = await rlmRequest("/save", { method: "POST", body: JSON.stringify({ settings: { port: Number(port) } }) });
          setDirty(false);
          return result;
        }, "Порт сохранён").then((result) => {
          if (result && result.needsRestart) setStatus({ kind: "ok", text: "Порт сохранён — нажмите «Перезапустить», затем обновите URL в MCP-менеджере." });
          return result;
        });

      // Таймауты — про выносливость: на слабой машине и сетевом диске обход дерева и сборка
      // идут в разы дольше, и жёсткий предел только мешает.
      const saveTimeouts = () =>
        run(async () => {
          const result = await rlmRequest("/save", {
            method: "POST",
            body: JSON.stringify({
              settings: { index: { probeTimeoutMin: Number(probeMin), jobTimeoutMin: Number(jobMin) } },
            }),
          });
          setDirty(false);
          return result;
        }, "Таймауты сохранены");

      const copySnippet = () => {
        if (!state) return;
        const done = () => setStatus({ kind: "ok", text: "JSON скопирован" });
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(state.mcp.snippet).then(done, () => setStatus({ kind: "error", text: "Буфер обмена недоступен" }));
        } else {
          setStatus({ kind: "error", text: "Буфер обмена недоступен — скопируйте текст вручную" });
        }
      };

      if (state === null) {
        return jsx("div", { style: { opacity: 0.7 }, children: status ? status.text : "Загрузка состояния сервера…" });
      }

      const server = state.server;
      const info = rlmBadge(server);
      const logLines = (state.logTail || []).filter((line) => line.trim()).slice(-10).join("\n");
      const statusLine = status
        ? jsx("div", { style: { fontSize: 12, color: status.kind === "ok" ? "#4caf50" : "#e57373" }, children: status.text })
        : null;

      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }, children: [
        jsx("div", { style: { fontSize: 14, fontWeight: 600 }, children: "rlm-tools-bsl" }),
        statusLine,
        jsxs("div", { style: rlmStyles.card, children: [
          jsxs("div", { style: rlmStyles.row, children: [
            jsx("span", { style: { color: info.color, fontSize: 14 }, children: info.dot }),
            jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: info.text }),
            jsx("div", { style: { flex: "1 1 auto" } }),
            jsx("button", { type: "button", style: rlmStyles.secondaryButton, disabled: busy, onClick: restart, children: "Перезапустить" }),
          ]}),
          jsx("div", { style: rlmStyles.path, children: server.url }),
          server.lastError
            ? jsxs("div", { children: [
                jsx("div", { style: { fontSize: 12, color: "#e57373", lineHeight: 1.5 }, children: server.lastError }),
                logLines ? jsx("pre", { style: rlmStyles.log, children: logLines }) : null,
              ]})
            : null,
        ]}),
        jsxs("div", { style: rlmStyles.card, children: [
          jsxs("div", { style: rlmStyles.row, children: [
            jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: "Порт" }),
            jsx("input", {
              style: rlmStyles.input,
              value: port,
              onChange: (event) => {
                setDirty(true);
                setPort(event.target.value);
              },
            }),
            jsx("button", { type: "button", style: rlmStyles.primaryButton, disabled: busy || !dirty, onClick: savePort, children: "Сохранить" }),
          ]}),
          jsx("div", { style: rlmStyles.hint, children: "После смены порта перезапустите сервер." }),
        ]}),
        jsxs("div", { style: rlmStyles.card, children: [
          jsxs("div", { style: rlmStyles.row, children: [
            jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: "Таймауты индексации" }),
            jsx("div", { style: { flex: "1 1 auto" } }),
            jsx("button", { type: "button", style: rlmStyles.primaryButton, disabled: busy || !dirty, onClick: saveTimeouts, children: "Сохранить" }),
          ]}),
          jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }, children: [
            jsx("span", { style: rlmStyles.hint, children: "Проверка свежести, мин" }),
            jsx("input", {
              style: { ...rlmStyles.input, width: 90 },
              value: probeMin,
              onChange: (event) => {
                setDirty(true);
                setProbeMin(event.target.value);
              },
            }),
            jsx("span", { style: rlmStyles.hint, children: "Сборка, мин" }),
            jsx("input", {
              style: { ...rlmStyles.input, width: 90 },
              value: jobMin,
              onChange: (event) => {
                setDirty(true);
                setJobMin(event.target.value);
              },
            }),
          ]}),
          jsx("div", { style: rlmStyles.hint, children: "Предел прогона. Достигнут — карточка скажет «состав файлов не проверен»." }),
        ]}),
        jsxs("div", { style: rlmStyles.card, children: [
          jsxs("div", { style: rlmStyles.row, children: [
            jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: "Подключение к DSH" }),
            jsx("div", { style: { flex: "1 1 auto" } }),
            jsx("button", { type: "button", style: rlmStyles.secondaryButton, onClick: copySnippet, children: "Скопировать JSON" }),
          ]}),
          jsx("pre", { style: rlmStyles.snippet, children: state.mcp.snippet }),
          jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 2 }, children: [
            (state.mcp.registration || []).filter((item) => !item.skipped).map((item) =>
              jsx("div", {
                key: item.manager,
                style: item.error ? { ...rlmStyles.hint, color: "#e57373" } : rlmStyles.hint,
                children: item.error
                  ? item.manager + ": ошибка записи — " + item.error
                  : item.manager + ": " + (item.action === "added" ? "добавлено" : item.action === "updated" ? "обновлено" : "уже прописано") + " (" + item.file + ")",
              })),
            jsx("div", { style: rlmStyles.hint, children: "Сервер прописывается в менеджер сам. Если вашего менеджера нет в списке — добавьте JSON вручную." }),
          ]}),
        ]}),
      ]});
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "1c-project-properties",
            order: 55,
            label: () => "1С: Параметры проектов",
            registrant: "dsh-1c-project-properties",
          },
          Section,
        ),
      );
      // Движок rlm — своя вкладка: параметры проекта и управление сервером анализа
      // кода разной природы, смешивать их в одном разделе незачем.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "rlm-tools-bsl",
            order: 56,
            label: () => "rlm-tools-bsl",
            registrant: "dsh-1c-project-properties",
          },
          RlmSection,
        ),
      );
      // Анализ кода — своя вкладка настроек: движок, наборы правил и состояние
      // по проектам. В параметрах проекта остались включение и выбор набора.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "1c-bsl-checks",
            order: 57,
            label: () => "1С: Анализ кода",
            registrant: "dsh-1c-project-properties",
          },
          ChecksSection,
        ),
      );
      // Визард живёт в общем слое поверх приложения: он показывается сразу после
      // добавления проекта, а не внутри панели настроек.
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "1c-project-wizard", order: 300 },
          WizardHost,
        ),
      );
      installCreateHook(ctx);
      installSidebarTab(ctx);
    }

    return { apply, inject: ["slots"] };
  },
});

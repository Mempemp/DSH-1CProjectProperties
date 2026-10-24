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
    // Набор, который раскладывает кнопка «Развернуть» — ссылка в заголовке карточки.
    const RULES_REPO = "https://github.com/comol/ai_rules_1c";

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok === false) {
        const detail = (data && data.error) || response.statusText || "HTTP " + response.status;
        // 404 без тела — это почти всегда рассинхрон половин плагина: клиентская
        // половина подхватывается перезагрузкой страницы, хост-часть — только
        // стартом DSH. Без объяснения такое читается как «плагин сломан».
        if (response.status === 404 && data === null) {
          throw new Error(
            "DSH не знает маршрут " + API + path + " (" + detail + "): в запущенном процессе старая хост-часть плагина. " +
            "Перезапустите DSH — клиентская половина обновляется перезагрузкой страницы, хост-часть только при старте.",
          );
        }
        throw new Error(detail);
      }
      return data;
    }

    // Маршруты индекса живут в dsh-rlm-tools-bsl (префикс /rlm), а не в /1cprops.
    async function rlmRequest(path, init) {
      const response = await fetch("/rlm" + path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const type = response.headers.get("content-type") || "";
      if (!type.includes("application/json")) {
        const error = new Error("маршрут /rlm" + path + " не найден: плагин dsh-rlm-tools-bsl не установлен");
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
/* Шаги визарда: серая полоса на весь путь, текущий шаг — зелёным свечением. */
/* Окно визарда одной высоты на всех шагах: страницы не раскачивают его размер.
   Считано по самой большой странице — «База и платформа». */
.p1c-dialog__body--wizard { height: 480px; max-height: calc(100vh - 226px); overflow-y: auto; scrollbar-gutter: stable; }
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
      error: { text: "ошибка проверки", tone: "err" },
      unavailable: { text: "rlm-bsl-index не найден", tone: "err" },
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
          const running = next.job && next.job.state === "running";
          if (
            !silent &&
            !autoRef.current &&
            next.enabled &&
            !running &&
            (status === "stale_age" || status === "stale_content" || status === "stale_structure")
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

      useEffect(() => {
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
          setData(next);
          setError(null);
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
          title: "Индекс rlm",
          children: jsx("div", {
            className: "p1c-note p1c-note--warn",
            children: "Плагин dsh-rlm-tools-bsl не установлен — индексом управлять нечем.",
          }),
        });
      }

      const index = data && data.index ? data.index : null;
      const job = data && data.job ? data.job : null;
      const project = data && data.project ? data.project : null;
      const sameJob = Boolean(job && job.path && job.path.toLowerCase() === path.toLowerCase());
      const running = Boolean(job && job.state === "running" && sameJob);
      const anyRunning = Boolean(job && job.state === "running");
      const status = index ? index.status : "unknown";
      const info = INDEX_STATUS[status] || INDEX_STATUS.unknown;
      const label = running ? (job.action === "update" ? "обновляется…" : "собирается…") : info.text;
      const action = status === "missing" ? "build" : "update";
      const canRun = Boolean(data && data.bin && data.enabled) && !anyRunning && !busy;

      return jsx(Card, {
        title: "Индекс rlm",
        hint: "Ускоряет поиск по именам и старт сессии. Обновляется при старте DSH, при открытии проекта и раз в неделю.",
        children: jsxs("div", {
          className: "p1c-stack",
          children: [
            jsxs("div", {
              style: { display: "flex", alignItems: "center", gap: 8 },
              children: [
                jsx(Dot, { tone: running ? "warn" : info.tone }),
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
                    jsx(Row, { label: "Схема", value: index.schema || "неизвестна" }),
                    jsx(Row, { label: "Собрано", value: index.built || "неизвестно" }),
                  ],
                })
              : null,
            index && index.dbPath ? jsx("div", { className: "p1c-note p1c-mono", children: index.dbPath }) : null,
            index && index.error && index.status !== "missing"
              ? jsx("div", { className: "p1c-note p1c-note--err", children: index.error })
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
            project && !project.lastError && !running && status === "missing" && project.lastAttemptAt
              ? jsxs("div", {
                  className: "p1c-note p1c-note--warn",
                  children: ["Последняя попытка ", whenText(project.lastAttemptAt), " прошла, но индекса в итоге нет."],
                })
              : null,
            data && data.logFile && project && project.lastError && !running
              ? jsxs("div", { className: "p1c-note p1c-mono", children: ["журнал: ", String(data.logFile)] })
              : null,
            jsx(Check, {
              checked: Boolean(data && data.enabled),
              disabled: busy || anyRunning,
              onChange: (event) => toggle(event.target.checked),
              children: "индексировать проект",
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
              ? jsx("div", { className: "p1c-note p1c-note--warn", children: "rlm-bsl-index не найден: установите rlm-tools-bsl." })
              : null,
            jsx("div", {
              className: "p1c-actions",
              children: jsx(Btn, {
                variant: "primary",
                disabled: !canRun,
                title: data && !data.bin ? "rlm-bsl-index не найден" : data && !data.enabled ? "сначала включите «индексировать проект»" : undefined,
                onClick: () => run(action),
                children: action === "build" ? "Собрать" : "Обновить",
              }),
            }),
            jsx("div", {
              className: "p1c-note",
              children: "Полная сборка — несколько минут, обновление — секунды. Пересборка нужна только при смене схемы индекса.",
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

    const WIZARD_STEPS = 5;
    const WIZARD_PLATFORM_LIST = "dsh-1cprops-wizard-platforms";
    const WIZARD_INFOBASE_LIST = "dsh-1cprops-wizard-infobases";
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
            body: JSON.stringify({ path: target.path, enabled: indexRlm }),
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

      const deployRules = async () => {
        setBusy(true);
        setStatus(null);
        try {
          const result = await request("/rules-deploy", {
            method: "POST",
            body: JSON.stringify({
              path: target.path,
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
      const rulesPayload = (state && state.rulesPayload) || null;
      const rulesPayloadOk = Boolean(rulesPayload && rulesPayload.ok);
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
        title: "Навыки для работы агента с 1С",
        hint: jsxs("span", {
          children: [
            "Набор ",
            jsx("a", { className: "p1c-link", href: RULES_REPO, target: "_blank", rel: "noreferrer", children: "1c-rules" }),
            " — правила, навыки и команды. Разворачивается в проект: .dsh/skills и AGENTS.md.",
          ],
        }),
        children: jsxs("div", {
          className: "p1c-stack",
          children: [
            rulesPayloadOk
              ? null
              : jsx("div", {
                  className: "p1c-note p1c-note--warn",
                  children:
                    "Набор «1c-rules» в DSH не найден: " +
                    ((rulesPayload && rulesPayload.root) || "$DSH_HOME/1c-rules") +
                    ". Его кладёт DSH Desktop при первом запуске.",
                }),
            jsxs("div", {
              className: "p1c-options",
              children: [
                jsx(Check, {
                  checked: rulesOptions.useEdt,
                  disabled: busy || !rulesPayloadOk,
                  onChange: (event) => setRulesOptions((o) => ({ ...o, useEdt: event.target.checked })),
                  title: "В EDT другой набор исходников — ссылки в правилах переписываются под его структуру",
                  children: "проект ведётся в 1С:EDT (другая структура исходников)",
                }),
                jsx(Check, {
                  checked: rulesOptions.includePassword,
                  disabled: busy || !rulesPayloadOk,
                  title: "Записать пароль базы в .dev.env (по умолчанию не переносится: файл часто попадает в git)",
                  onChange: (event) => setRulesOptions((o) => ({ ...o, includePassword: event.target.checked })),
                  children: "записать пароль базы в .dev.env",
                }),
              ],
            }),
            jsx("div", {
              className: "p1c-actions",
              children: jsx(Btn, {
                variant: "primary",
                disabled: busy || !rulesPayloadOk,
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
        title: "Индекс rlm",
        hint: "Индекс ускоряет поиск по именам и старт сессии. Сборка идёт в фоне; прогресс — в параметрах проекта. Включайте, когда исходники уже выгружены.",
        children: jsx(Check, {
          checked: indexRlm,
          onChange: (event) => setIndexRlm(event.target.checked),
          children: "построить индекс rlm для этого проекта",
        }),
      });

      const stepDump = jsxs("div", {
        className: "p1c-stack",
        children: [dumpCard, rlmCard],
      });

      const effectivePlatform = form.platformPath || commonPlatform;
      const rulesSummary = rulesResult && rulesResult.ok
        ? "развёрнуты"
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
                jsx(Row, { label: "Индекс rlm", value: indexRlm ? "включён" : "выключен" }),
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

      const bodyByStep = [stepKind, stepBase, stepRules, stepDump, stepDone];
      const stepNames = ["Проект 1С", "База и платформа", "Навыки", "Выгрузка", "Готово"];

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
        rulesPayload,
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
      const rulesPayloadOk = Boolean(rulesPayload && rulesPayload.ok);
      const rulesPayloadRoot = rulesPayload && rulesPayload.root ? rulesPayload.root : "$DSH_HOME/1c-rules";
      const rulesResultSummary = rulesResult && rulesResult.summary
        ? Object.entries(RESULT_LABEL)
            .filter(([key]) => Number(rulesResult.summary[key]) > 0)
            .map(([key, label]) => label + ": " + rulesResult.summary[key])
            .join(" · ")
        : "";

      const rulesResultBlock = rulesResult
        ? jsxs("div", {
            className: "p1c-stack p1c-stack--tight",
            children: [
              jsx("div", {
                className: cx("p1c-sm p1c-strong", rulesResult.ok === false && "p1c-text--err"),
                children: rulesResult.ok === false
                  ? "Развернуть не удалось"
                  : rulesResult.dryRun ? "Предпросмотр (ничего не записано)" : "Развёртывание выполнено",
              }),
              rulesResult.ok === false
                ? jsx("div", {
                    className: "p1c-note p1c-note--err",
                    children: String(rulesResult.error || "причина не сообщена"),
                  })
                : jsx("div", { className: "p1c-note", children: rulesResultSummary || "изменений нет" }),
              ...(rulesResult.notes || []).map((note, index) =>
                jsx("div", { key: "n" + index, className: "p1c-note", children: note }),
              ),
              ...(rulesResult.warnings || []).map((warning, index) =>
                jsx("div", { key: "w" + index, className: "p1c-note p1c-note--warn", children: warning }),
              ),
              ...(() => {
                const preserved = (rulesResult.files || []).filter((file) => file.status === "preserved");
                if (preserved.length === 0) return [];
                const shown = preserved.slice(0, 3);
                return [
                  jsxs("div", {
                    key: "preserved",
                    className: "p1c-note",
                    children: [
                      jsx("div", { children: "Оставлено ваше (" + preserved.length + "):" }),
                      ...shown.map((file, index) =>
                        jsx("div", { key: index, className: "p1c-mono", children: file.path + (file.detail ? " — " + file.detail : "") }),
                      ),
                      preserved.length > shown.length
                        ? jsx("div", { children: "и ещё " + (preserved.length - shown.length) })
                        : null,
                    ],
                  }),
                ];
              })(),
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
                className: "p1c-dialog__body",
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
                    hint: jsxs("span", {
                      children: [
                        "Набор ",
                        jsx("a", { className: "p1c-link", href: RULES_REPO, target: "_blank", rel: "noreferrer", children: "1c-rules" }),
                        " раскладывается в проект: .dsh/rules-1c, .dsh/agents-1c, .dsh/commands-1c, .dsh/skills и AGENTS.md в корне.",
                      ],
                    }),
                    children: jsxs("div", {
                      className: "p1c-stack",
                      children: [
                        rulesPayloadOk
                          ? null
                          : jsx("div", {
                              className: "p1c-note p1c-note--warn",
                              children: "Набор «1c-rules» в DSH не найден: " + rulesPayloadRoot +
                                ". Его кладёт DSH Desktop при первом запуске; в standalone-установке положите набор в этот каталог вручную.",
                            }),
                        jsxs("div", {
                          className: "p1c-options",
                          children: [
                            jsx(Check, {
                              checked: rulesOptions.useEdt,
                              disabled: busy || !rulesPayloadOk,
                              onChange: (event) => setRulesOptions((o) => ({ ...o, useEdt: event.target.checked })),
                              children: "в проекте используется 1С:EDT",
                            }),
                            jsx(Check, {
                              checked: rulesOptions.includePassword,
                              disabled: busy || !rulesPayloadOk,
                              title: "Записать пароль базы в .dev.env (по умолчанию не переносится: файл часто попадает в git)",
                              onChange: (event) => setRulesOptions((o) => ({ ...o, includePassword: event.target.checked })),
                              children: "записать пароль базы в .dev.env",
                            }),
                          ],
                        }),
                        jsx("div", {
                          className: "p1c-actions",
                          children: jsx(Btn, {
                            variant: "primary",
                            disabled: busy || !rulesPayloadOk,
                            title: rulesPayloadOk
                              ? "Разложить набор правил в проект: .dsh/rules-1c, .dsh/agents-1c, .dsh/commands-1c, .dsh/skills, AGENTS.md"
                              : "Набор правил не найден в DSH: " + rulesPayloadRoot,
                            onClick: () => onRulesDeploy(false),
                            children: "Развернуть",
                          }),
                        }),
                        jsx("div", {
                          className: "p1c-note",
                          children: "Существующий AGENTS.md не затирается: он сохраняется как AGENTS.md.bak.md и вклеивается в USER-RULES.md; " +
                            "файлы с вашими правками при обновлении не перезаписываются, .dev.env и openspec/ создаются один раз.",
                        }),
                        rulesResultBlock
                          ? jsxs("details", {
                              className: "p1c-details",
                              open: true,
                              children: [
                                jsx(Summary, { children: "Результат последнего запуска" }),
                                jsx("div", { className: "p1c-details__body", children: rulesResultBlock }),
                              ],
                            })
                          : null,
                      ],
                    }),
                  }),
                  jsx(RlmIndexCard, { path: project.path }),
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
      }, [openPath]);

      const deployRulesTo = () =>
        run(async () => {
          const body = {
            path: project.path,
            includePassword: rulesOptions.includePassword,
            useEdt: rulesOptions.useEdt,
          };
          try {
            setRulesResult(await request("/rules-deploy", { method: "POST", body: JSON.stringify(body) }));
          } catch (error) {
            // Отказ хоста (нет набора, нет прав) — это результат операции, а не
            // молчание: показываем его в карточке правил.
            setRulesResult({ ok: false, error: String((error && error.message) || error) });
            throw error;
          }
        }, "Правила развёрнуты в проект");

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
            rulesPayload: state.rulesPayload || null,
            rulesResult,
            rulesOptions,
            setRulesOptions,
            onRulesDeploy: deployRulesTo,
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
      // Визард живёт в общем слое поверх приложения: он показывается сразу после
      // добавления проекта, а не внутри панели настроек.
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "1c-project-wizard", order: 300 },
          WizardHost,
        ),
      );
      installCreateHook(ctx);
    }

    return { apply, inject: ["slots"] };
  },
});

'use client';

import { useRef, useState, type InputHTMLAttributes, type RefObject, type TextareaHTMLAttributes } from 'react';
import { EmojiPicker } from './EmojiPicker';
import { cx, Icons, Input } from './ui';

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * Coloca o emoji onde está o cursor, como se a pessoa tivesse digitado: dispara o `input`
 * nativo para o `onChange` do React rodar (inclusive filtros como o do nome de canal).
 */
export function insertIntoField(el: Field, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  if (el.maxLength > 0 && next.length > el.maxLength) return;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const pos = start + text.length;
  el.focus();
  requestAnimationFrame(() => el.setSelectionRange(pos, pos));
}

/** Botão de emojis para o fim de uma caixa de texto (abre o seletor padrão do Line). */
export function EmojiButton({ target, className, size = 18, onPickerClose }: { target: RefObject<Field | null>; className?: string; size?: number; onPickerClose?: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        title="Emojis"
        aria-label="Emojis"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
        className={cx('flex shrink-0 items-center justify-center text-muted hover:text-fg', anchor && 'text-fg', className)}
      >
        <Icons.Smile size={size} />
      </button>
      {anchor && (
        <EmojiPicker
          anchor={anchor}
          onClose={() => {
            setAnchor(null);
            onPickerClose?.();
          }}
          onPick={(emoji, keepOpen) => {
            if (target.current) insertIntoField(target.current, emoji);
            if (!keepOpen) setAnchor(null);
          }}
        />
      )}
    </>
  );
}

/** `Input` do Line com o botão de emojis no fim. */
export function EmojiInput({ className, wrapClassName, ...props }: InputHTMLAttributes<HTMLInputElement> & { wrapClassName?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={cx('relative', wrapClassName)}>
      <Input {...props} ref={ref} className={cx('pr-9', className)} />
      <EmojiButton target={ref} className="absolute top-1/2 right-2.5 -translate-y-1/2" />
    </div>
  );
}

/** Caixa de texto de várias linhas com o botão de emojis no canto de baixo. */
export function EmojiTextarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="relative">
      <textarea {...props} ref={ref} className={cx(className, 'pr-9')} />
      <EmojiButton target={ref} className="absolute right-2.5 bottom-3" />
    </div>
  );
}

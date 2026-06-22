import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, useInput } from "ink";

export interface ComposerInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  mask?: boolean;
}

export function ComposerInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  focus = true,
  mask = false,
}: ComposerInputProps): React.JSX.Element {
  const graphemes = useMemo(() => splitGraphemes(value), [value]);
  const [cursor, setCursor] = useState(graphemes.length);
  const valueRef = useRef(value);
  const lastEmittedValue = useRef(value);
  const cursorRef = useRef(cursor);
  valueRef.current = value;
  cursorRef.current = Math.min(cursor, graphemes.length);

  useEffect(() => {
    if (value !== lastEmittedValue.current) setCursor(graphemes.length);
    else setCursor((current) => Math.min(current, graphemes.length));
    lastEmittedValue.current = value;
  }, [graphemes.length, value]);

  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    const current = splitGraphemes(valueRef.current);
    const offset = Math.min(cursorRef.current, current.length);
    if (key.return) {
      onSubmit(valueRef.current);
      setCursor(0);
      return;
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, offset - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(current.length, offset + 1));
      return;
    }
    if (key.backspace || key.delete) {
      if (offset === 0) return;
      current.splice(offset - 1, 1);
      setCursor(offset - 1);
      const next = current.join("");
      lastEmittedValue.current = next;
      onChange(next);
      return;
    }
    if (!input || key.escape || key.tab || key.upArrow || key.downArrow) return;
    const inserted = splitGraphemes(input);
    current.splice(offset, 0, ...inserted);
    setCursor(offset + inserted.length);
    const next = current.join("");
    lastEmittedValue.current = next;
    onChange(next);
  }, { isActive: focus });

  if (!value) return <Text dimColor>{placeholder || " "}</Text>;
  const visible = mask ? graphemes.map(() => "•") : graphemes;
  const before = visible.slice(0, cursorRef.current).join("");
  const active = visible[cursorRef.current] ?? " ";
  const after = visible.slice(cursorRef.current + 1).join("");
  return <Text>{before}<Text inverse>{active}</Text>{after}</Text>;
}

export function splitGraphemes(value: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), (item) => item.segment);
  }
  return Array.from(value);
}

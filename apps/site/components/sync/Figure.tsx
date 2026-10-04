"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export interface Step {
  caption: string;
  /** How long this step holds before the next, in ms. */
  hold: number;
}

/**
 * Drives a figure through its steps.
 *
 * - Plays only while at least a third of the figure is on screen, so nothing moves out of view
 *   and the page does no work for figures nobody is looking at.
 * - Under `prefers-reduced-motion: reduce` it starts on the last step and does not advance by
 *   itself: you see the end state, still and complete. The step buttons still work.
 * - Pausing is always available (WCAG 2.2.2: moving content longer than five seconds).
 */
export function useStepper(steps: readonly Step[]) {
  const last = steps.length - 1;
  const [step, setStep] = useState(last);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setReduced(mq.matches);
      if (mq.matches) {
        setPlaying(false);
        setStep(last);
      } else {
        setStep(0);
        setPlaying(true);
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [last]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), {
      threshold: 0.33,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    const t = window.setTimeout(
      () => setStep((s) => (s >= last ? 0 : s + 1)),
      steps[step]?.hold ?? 2000,
    );
    return () => window.clearTimeout(t);
  }, [playing, visible, step, steps, last]);

  const toggle = useCallback(() => setPlaying((p) => !p), []);
  const prev = useCallback(() => {
    setPlaying(false);
    setStep((s) => Math.max(0, s - 1));
  }, []);
  const next = useCallback(() => {
    setPlaying(false);
    setStep((s) => Math.min(last, s + 1));
  }, [last]);

  return { step, playing, reduced, ref, toggle, prev, next };
}

export function FigureFrame({
  label,
  steps,
  stepper,
  children,
  name,
}: {
  label: string;
  name: string;
  steps: readonly Step[];
  stepper: ReturnType<typeof useStepper>;
  children: ReactNode;
}) {
  const { step, playing, reduced, ref, toggle, prev, next } = stepper;
  return (
    <figure
      className="figure"
      ref={ref}
      data-figure={name}
      data-step={step}
      data-playing={playing}
      data-reduced={reduced}
      aria-label={label}
    >
      <div className="figure__stage">{children}</div>
      <div className="figure__bar">
        <div className="figure__caption">
          <figcaption>
            <span className="visually-hidden">
              Step {step + 1} of {steps.length}:{" "}
            </span>
            {steps[step]?.caption}
          </figcaption>
          <div className="figure__progress" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.caption} data-done={i <= step} />
            ))}
          </div>
        </div>
        <div className="figure__controls">
          <button
            type="button"
            className="icon-button"
            onClick={prev}
            aria-label="Previous step"
            disabled={step === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M15 5 8 12l7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={toggle}
            aria-label={playing ? "Pause animation" : "Play animation"}
            aria-pressed={playing}
          >
            {playing ? (
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="6.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
                <rect x="14" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7.5 5.5v13l11-6.5z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={next}
            aria-label="Next step"
            disabled={step === steps.length - 1}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="m9 5 7 7-7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </figure>
  );
}

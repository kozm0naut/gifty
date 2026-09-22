import React from 'react';

interface NumberStepperProps {
  id: string;
  value: number | '';
  onChange: (value: number | '') => void;
  min?: number;
  step?: number;
  required?: boolean;
  placeholder?: string;
}

export function NumberStepper({
  id,
  value,
  onChange,
  min = 0,
  step = 1,
  required,
  placeholder,
}: NumberStepperProps) {
  const nudge = (direction: 1 | -1) => {
    const current = value === '' ? 0 : value;
    const next = Math.max(min, current + direction * step);
    onChange(Number(next.toFixed(2)));
  };

  return (
    <div className="stepper">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        required={required}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className="input"
      />
      <div className="stepper-controls">
        <button
          type="button"
          className="stepper-btn"
          aria-label="Increase"
          onClick={() => nudge(1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
        <button
          type="button"
          className="stepper-btn"
          aria-label="Decrease"
          onClick={() => nudge(-1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

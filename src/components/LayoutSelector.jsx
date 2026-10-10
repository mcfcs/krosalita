import React from 'react';
import { Edit3, Plus } from './Icons';

const LayoutSelector = ({
  isOpen,
  layouts,
  activeTab,
  layoutIndexForTab,
  onSelect,
  onClose,
  onCreateLayout,
  onEditLayout,
  title = 'Select Layout',
}) => {
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-[998]" onClick={onClose} />
      <div
        className="fixed z-[999] panel shadow-press overflow-hidden min-w-[244px] max-h-[70vh] flex flex-col animate-rise-in"
        style={{ top: '300px', left: '50%', transform: 'translateX(-50%)' }}
      >
        <div className="bg-paper-sunken px-4 py-2.5 border-b border-ink/12 flex items-center justify-between gap-3">
          <span className="eyebrow">{title}</span>
          <div className="flex gap-1.5">
            <button onClick={onCreateLayout} className="btn btn-sm btn-accent">
              <Plus size={13} />New
            </button>
            <button onClick={onEditLayout} className="btn btn-sm btn-ghost">
              <Edit3 size={13} />Edit
            </button>
          </div>
        </div>
        <div className="overflow-y-auto">
        {layouts.map((layout, idx) => (
          <button
            key={idx}
            onClick={() => onSelect(idx, activeTab)}
            className={`w-full px-4 py-2.5 text-left transition flex items-center justify-between gap-4 border-b border-ink/8 last:border-0 ${layoutIndexForTab === idx ? 'bg-accent/10 text-accent-deep font-semibold' : 'text-ink-soft hover:bg-ink/[0.04]'}`}
          >
            <span>{layout.name}</span>
            <span className="font-mono text-xs text-ink-faint">{layout.grid.length}×{layout.grid[0].length}</span>
          </button>
        ))}
        </div>
      </div>
    </>
  );
};

export default LayoutSelector;

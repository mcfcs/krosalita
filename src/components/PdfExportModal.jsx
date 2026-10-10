import React, { useEffect, useRef, useState } from 'react';
import { Download, X, Share } from './Icons';
import { buildCrosswordPdf, pdfFileName } from '../utils/pdfExport';
import { loadJSON, saveJSON } from '../utils/storage';

// Print-ready, newspaper-style PDF of the current puzzle. The page itself is laid out by
// utils/pdfExport (jsPDF, loaded on first use); this is the form around it and a live
// preview. Title and byline are remembered, because a constructor signs every puzzle the
// same way.

const PREFS_KEY = 'pdfPrefs';
const today = () => new Date().toLocaleDateString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
});

const PdfExportModal = ({ open, puzzle, defaultTitle = '', difficultyLabel = '', onClose, onDownloadPng }) => {
  const [prefs, setPrefs] = useState(() => ({
    title: '', author: '', pageSize: 'letter', answerKey: true, color: true, showDifficulty: true,
    ...loadJSON(PREFS_KEY, {}),
  }));
  const [dateLabel, setDateLabel] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const urlRef = useRef('');
  // Phones can't show a PDF inside an iframe, so the preview is desktop-only.
  const canPreview = typeof window !== 'undefined' && !window.matchMedia?.('(pointer: coarse)').matches;

  const set = (patch) => setPrefs((p) => {
    const next = { ...p, ...patch };
    saveJSON(PREFS_KEY, { title: next.title, author: next.author, pageSize: next.pageSize, answerKey: next.answerKey, color: next.color, showDifficulty: next.showDifficulty });
    return next;
  });

  const options = {
    title: prefs.title.trim() || defaultTitle || 'The Crossword',
    author: prefs.author.trim(),
    dateLabel: dateLabel.trim(),
    difficultyLabel: prefs.showDifficulty ? difficultyLabel : '',
    pageSize: prefs.pageSize,
    answerKey: prefs.answerKey,
    color: prefs.color,
  };
  const optionsKey = JSON.stringify(options);

  const build = () => buildCrosswordPdf(puzzle, options);

  // Debounced live preview. Each build replaces the last object URL, and the old one is
  // revoked so a long session of tweaking does not pile up blobs.
  useEffect(() => {
    if (!open || !puzzle || !canPreview) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const blob = await build();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPreviewUrl(url);
        setError('');
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not build the PDF.');
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, puzzle, optionsKey, canPreview]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  if (!open) return null;

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const blob = await build();
      const name = pdfFileName(options);
      // On a phone the share sheet is where "Save to Files" and "Print" live.
      const file = typeof File !== 'undefined' ? new File([blob], name, { type: 'application/pdf' }) : null;
      if (!canPreview && file && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: options.title }); return; } catch { /* fall through to download */ }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      setError(err?.message || 'Could not build the PDF.');
    } finally {
      setBusy(false);
    }
  };

  const openToPrint = async () => {
    setError('');
    try {
      const blob = await build();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setError(err?.message || 'Could not build the PDF.');
    }
  };

  const toggle = (key, label, hint) => (
    <label className="flex items-start gap-2 text-sm text-ink-soft cursor-pointer select-none" title={hint}>
      <input type="checkbox" className="mt-0.5" checked={!!prefs[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-[1250] bg-ink/45 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-6" onClick={onClose} role="dialog" aria-modal="true" aria-label="Export PDF">
      <div className={`panel w-full ${canPreview ? 'max-w-5xl' : 'max-w-md'} max-h-[94vh] overflow-y-auto p-5 sm:p-6 animate-rise-in`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="eyebrow">Print edition</div>
            <h3 className="font-display text-2xl font-semibold text-ink leading-tight">Save as PDF</h3>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink p-1" aria-label="Close"><X size={18} /></button>
        </div>

        <div className={canPreview ? 'grid grid-cols-1 md:grid-cols-[minmax(0,19rem)_1fr] gap-5' : ''}>
          <div className="space-y-3">
            <label className="block">
              <span className="eyebrow">Title</span>
              <input className="field mt-1" value={prefs.title} placeholder={defaultTitle || 'The Crossword'} onChange={(e) => set({ title: e.target.value })} />
            </label>
            <label className="block">
              <span className="eyebrow">Byline</span>
              <input className="field mt-1" value={prefs.author} placeholder="Your name" onChange={(e) => set({ author: e.target.value })} />
            </label>
            <label className="block">
              <span className="eyebrow">Dateline</span>
              <input className="field mt-1" value={dateLabel} onChange={(e) => setDateLabel(e.target.value)} />
            </label>
            <div>
              <span className="eyebrow">Paper</span>
              <div className="flex gap-1.5 mt-1">
                {[['letter', 'US Letter'], ['a4', 'A4']].map(([id, label]) => (
                  <button key={id} onClick={() => set({ pageSize: id })} className={`px-3 py-1.5 rounded-sm border text-xs font-semibold ${prefs.pageSize === id ? 'border-ink bg-ink text-paper-raised' : 'border-ink/25 text-ink-soft hover:bg-ink/5'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5 pt-1">
              {toggle('answerKey', 'Answer key on page 2')}
              {toggle('color', 'Print shaded squares in colour', 'Off prints every shade as grey — better for a black-and-white printer')}
              {difficultyLabel && toggle('showDifficulty', `Show difficulty (${difficultyLabel})`)}
            </div>

            {error && <div className="border-l-2 border-accent bg-accent/8 px-3 py-2 text-accent-deep text-sm">{error}</div>}

            <div className="flex flex-col gap-2 pt-2">
              <button onClick={download} disabled={busy || !puzzle} className="btn btn-accent w-full justify-center">
                <Download size={16} />{busy ? 'Building…' : 'Download PDF'}
              </button>
              {canPreview && (
                <button onClick={openToPrint} disabled={!puzzle} className="btn w-full justify-center" title="Opens in a new tab, ready for the print dialog">
                  <Share size={15} />Open to print
                </button>
              )}
              {onDownloadPng && (
                <button onClick={onDownloadPng} className="text-xs text-ink-faint underline hover:text-ink self-center py-1">
                  Or a PNG image + answers.txt
                </button>
              )}
            </div>
          </div>

          {canPreview && (
            <div className="min-h-[24rem] md:min-h-[34rem] border border-line rounded-sm bg-paper-sunken overflow-hidden">
              {previewUrl
                ? <iframe title="PDF preview" src={`${previewUrl}#toolbar=0&view=FitH`} className="w-full h-full min-h-[24rem] md:min-h-[34rem]" />
                : <div className="h-full flex items-center justify-center text-ink-faint text-sm">Setting type…</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PdfExportModal;

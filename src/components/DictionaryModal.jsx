import React from 'react';
import { BookOpen, Plus, Download, Search, Check, X, Edit3, Trash2 } from './Icons';
import { renderRich } from '../utils/richText.jsx';

const DictionaryModal = ({
  isOpen,
  onClose,
  words,
  dictionarySearch,
  setDictionarySearch,
  newWord,
  setNewWord,
  newClue,
  setNewClue,
  addWordToDictionary,
  exportDictionary,
  getFilteredWords,
  editingWordIndex,
  setEditingWordIndex,
  editWord,
  setEditWord,
  editClue,
  setEditClue,
  saveEditWord,
  startEditWord,
  deleteWordFromDictionary
}) => {
  if (!isOpen) return null;

  const filteredWords = getFilteredWords();

  return (
    <div className="fixed inset-0 z-[1000] bg-ink/45 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="panel w-full max-w-4xl max-h-[90vh] flex flex-col animate-rise-in">
        <div className="panel-pad pb-5 border-b border-ink/12">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="eyebrow flex items-center gap-1.5"><BookOpen size={13} />Reference</div>
              <h2 className="font-display text-3xl font-semibold text-ink leading-tight">The Lexicon</h2>
            </div>
            <button onClick={onClose} className="p-2 -mr-1 text-ink-faint hover:text-ink transition">
              <X size={22} />
            </button>
          </div>

          <div className="flex gap-2.5 flex-wrap">
            <input
              type="text"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value.toUpperCase())}
              placeholder="New word…"
              className="field flex-1 min-w-[120px] font-mono uppercase tracking-wide"
            />
            <input
              type="text"
              value={newClue}
              onChange={(e) => setNewClue(e.target.value)}
              placeholder="Clue for this word…"
              className="field flex-[2] min-w-[200px]"
            />
            <button onClick={addWordToDictionary} className="btn btn-accent">
              <Plus size={16} />Add
            </button>
            <button onClick={exportDictionary} className="btn">
              <Download size={16} />Export CSV
            </button>
          </div>

          <div className="mt-3 relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              type="text"
              value={dictionarySearch}
              onChange={(e) => setDictionarySearch(e.target.value)}
              placeholder="Search words or clues…"
              className="field pl-10"
            />
          </div>

          <div className="mt-3 eyebrow">{words.length} entries on file</div>
        </div>

        <div className="flex-1 overflow-y-auto panel-pad">
          {filteredWords.length === 0 ? (
            <div className="text-center text-ink-faint py-10 italic">
              {words.length === 0 ? 'No words yet — add some or upload a CSV.' : 'No matching words found.'}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredWords.slice(0, 200).map((item) => {
                const originalIndex = words.indexOf(item);
                const isEditing = editingWordIndex === originalIndex;

                return (
                  <div key={originalIndex} className="flex items-start gap-3 px-3 py-2 rounded-sm hover:bg-ink/[0.04] transition border-b border-ink/8 last:border-0">
                    {isEditing ? (
                      <>
                        <input
                          type="text"
                          value={editWord}
                          onChange={(e) => setEditWord(e.target.value.toUpperCase())}
                          className="field w-28 sm:w-32 shrink-0 font-mono text-accent py-1"
                        />
                        <input
                          type="text"
                          value={editClue}
                          onChange={(e) => setEditClue(e.target.value)}
                          className="field flex-1 min-w-0 py-1"
                        />
                        <button onClick={saveEditWord} className="shrink-0 p-2 text-grass hover:bg-grass/10 rounded-sm transition">
                          <Check size={17} />
                        </button>
                        <button onClick={() => setEditingWordIndex(null)} className="shrink-0 p-2 text-accent hover:bg-accent/10 rounded-sm transition">
                          <X size={17} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="w-24 sm:w-32 shrink-0 font-mono font-semibold text-accent tracking-wide break-words">{item.word}</span>
                        <span className="flex-1 min-w-0 text-ink-soft text-sm break-words">{renderRich(item.clue)}</span>
                        <button onClick={() => startEditWord(originalIndex)} className="shrink-0 p-2 text-ink-faint hover:text-ink hover:bg-ink/[0.06] rounded-sm transition">
                          <Edit3 size={15} />
                        </button>
                        <button onClick={() => deleteWordFromDictionary(originalIndex)} className="shrink-0 p-2 text-ink-faint hover:text-accent hover:bg-accent/10 rounded-sm transition">
                          <Trash2 size={15} />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
              {filteredWords.length > 200 && (
                <div className="text-center text-ink-faint py-4 text-sm italic">
                  Showing first 200 of {getFilteredWords().length} results
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DictionaryModal;

'use client';

import { useState } from 'react';
import { Plus, Trash2, Undo2 } from 'lucide-react';
import { Field, Panel } from './BusinessUi';

type EditableQuestion = { id: string; title: string; prompt: string };

export default function DiscoveryQuestionEditor<T extends EditableQuestion>({
    questions, onChange, createQuestion, hint,
}: {
    questions: T[];
    onChange: (questions: T[]) => void;
    createQuestion: () => T;
    hint: string;
}) {
    const [removed, setRemoved] = useState<{ question: T; index: number } | null>(null);
    const update = (id: string, patch: Partial<EditableQuestion>) => {
        onChange(questions.map(question => question.id === id ? { ...question, ...patch } : question));
    };
    const remove = (id: string) => {
        const index = questions.findIndex(question => question.id === id);
        if (index < 0) return;
        setRemoved({ question: questions[index], index });
        onChange(questions.filter(question => question.id !== id));
    };
    const undo = () => {
        if (!removed) return;
        const restored = [...questions];
        restored.splice(Math.min(removed.index, restored.length), 0, removed.question);
        onChange(restored);
        setRemoved(null);
    };
    return (
        <Panel
            title="Edit discovery questions"
            action={
                <button className="btn btn-outline" disabled={questions.length >= 30} onClick={() => onChange([...questions, createQuestion()])}>
                    <Plus className="w-3.5 h-3.5" /> Add question
                </button>
            }
        >
            <p className="text-sm text-[var(--text-dim)]">{hint}</p>
            {removed && (
                <div className="call-question-undo" role="status">
                    <span>Deleted “{removed.question.title}”.</span>
                    <button className="btn btn-ghost" disabled={questions.length >= 30} onClick={undo}>
                        <Undo2 className="w-3.5 h-3.5" /> Undo delete
                    </button>
                </div>
            )}
            {!questions.length ? (
                <p className="text-sm text-[var(--text-dim)] py-5">No questions yet. Add a question to start your conversation guide.</p>
            ) : (
                <div className="space-y-6">
                    {questions.map((question, index) => (
                        <div key={question.id} className="call-template-question">
                            <div className="call-question-edit-heading">
                                <p className="call-eyebrow">Question {index + 1}</p>
                                <button className="btn btn-ghost call-question-delete" aria-label={`Delete question ${index + 1}`} onClick={() => remove(question.id)}>
                                    <Trash2 className="w-3.5 h-3.5" /> Delete
                                </button>
                            </div>
                            <Field label={`Question title ${index + 1}`} value={question.title} onChange={title => update(question.id, { title })} />
                            <Field label={`Question wording ${index + 1}`} multiline value={question.prompt} onChange={prompt => update(question.id, { prompt })} />
                        </div>
                    ))}
                </div>
            )}
        </Panel>
    );
}

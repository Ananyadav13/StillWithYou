import { useCallback, useEffect, useRef, useState } from 'react';
import { createMessage, getAnalysis } from '../api/client';
import type { Message } from '../types/message';

/** How often to ask the backend whether analysis has landed. */
const POLL_INTERVAL_MS = 500;
/** Give up after this long so a stuck job cannot leak a timer forever. */
const POLL_TIMEOUT_MS = 30_000;

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);

  // Tracked so unmounting cancels every in-flight poll loop.
  const pollTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const pollAnalysis = useCallback((messageId: string) => {
    const startedAt = Date.now();

    const tick = async () => {
      try {
        const analysis = await getAnalysis(messageId);

        if (analysis.analysis_status !== 'pending') {
          if (import.meta.env.DEV) {
            // Pairs the avatar's visible state with the value that actually drove it, so
            // a screen recording can be checked against real pipeline output instead of
            // being taken on trust. Phase 4 Step 3 evidence.
            console.info(
              `[avatar] ${new Date().toISOString()} id=${messageId.slice(0, 8)} ` +
                `status=${analysis.analysis_status} mood=${analysis.mood} ` +
                `settled_after=${Date.now() - startedAt}ms`,
            );
          }

          setMessages((prev) =>
            prev.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    analysisStatus: analysis.analysis_status,
                    mood: analysis.mood,
                    toxicityScore: analysis.toxicity_score,
                    heatScore: analysis.heat_score,
                    rewriteSuggestion: analysis.rewrite_suggestion,
                  }
                : message,
            ),
          );
          return;
        }
      } catch (error) {
        console.error('Analysis poll failed:', error);
        return;
      }

      if (Date.now() - startedAt < POLL_TIMEOUT_MS) {
        const timer = setTimeout(tick, POLL_INTERVAL_MS);
        pollTimers.current.add(timer);
      }
    };

    void tick();
  }, []);

  // Analysis triggers only at send time to bound Gemini call volume.
  //
  // This is deliberate, not an oversight. `setInput` is the only thing wired to
  // the textarea's onChange, so keystrokes stay entirely in React state and reach
  // no network. Debouncing a per-keystroke call would still send one request per
  // pause; sending only on submit sends exactly one request per message, which is
  // the smallest number that can possibly work.
  //
  // The saving is not marginal. A 200-character message typed at a natural pace
  // is ~200 keystrokes and, with a 400ms debounce, roughly 15-30 requests. Here it
  // is 1 - a 95%+ reduction in calls against an API that has already shown us
  // quota exhaustion and multi-second tail latency.
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim()) {
        return;
      }

      // Optimistic bubble so the UI never waits on the network. Its temporary id
      // is swapped for the server's once the row exists, because that id is what
      // the analysis endpoint is keyed on.
      const temporaryId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        {
          id: temporaryId,
          content: text,
          sender: 'user',
          timestamp: new Date().toISOString(),
          analysisStatus: 'pending',
        },
      ]);
      setInput('');
      setIsSending(true);

      try {
        const created = await createMessage(text);

        setMessages((prev) =>
          prev.map((message) =>
            message.id === temporaryId
              ? {
                  ...message,
                  id: created.id,
                  timestamp: created.created_at,
                  analysisStatus: created.analysis_status,
                }
              : message,
          ),
        );

        pollAnalysis(created.id);
      } catch (error) {
        console.error('Send failed:', error);
      } finally {
        setIsSending(false);
      }
    },
    [pollAnalysis],
  );

  // The avatar reflects the message the user most recently sent — that is the one they
  // are being given a second opinion on. It reads the same polled state the message list
  // renders from, so there is no separate fetch and no way for the two to disagree.
  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;

  return {
    messages,
    input,
    setInput,
    isSending,
    sendMessage,
    avatarMessageId: latestMessage?.id ?? null,
    avatarMood: latestMessage?.mood ?? null,
    avatarAnalysisStatus: latestMessage?.analysisStatus ?? null,
  };
}

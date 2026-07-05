import { MessageBubble } from './MessageBubble';
import type { Message } from '../types/message';

interface ChatWindowProps {
  messages: Message[];
}

export function ChatWindow({ messages }: ChatWindowProps) {
  return (
    <div className="flex-1 overflow-y-auto rounded-3xl bg-slate-50/70 p-4 shadow-inner">
      <div className="flex min-h-full flex-col gap-3">
        {messages.length === 0 ? (
          <div className="mt-auto rounded-2xl border border-dashed border-slate-300 bg-white/70 p-6 text-center text-sm text-slate-500">
            Start the conversation with a message.
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>
    </div>
  );
}

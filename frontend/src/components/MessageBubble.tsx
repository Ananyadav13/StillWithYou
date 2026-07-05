import type { Message } from '../types/message';

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.sender === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${
          isUser
            ? 'bg-indigo-600 text-white'
            : 'bg-white text-slate-800 border border-slate-200'
        }`}
      >
        <p className="text-sm leading-6">{message.content}</p>
        <p className={`mt-2 text-[11px] ${isUser ? 'text-indigo-100' : 'text-slate-400'}`}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </p>
      </div>
    </div>
  );
}

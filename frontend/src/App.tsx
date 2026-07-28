import { Avatar } from './components/Avatar/Avatar';
import { AvatarDebugGrid } from './components/Avatar/AvatarDebugGrid';
import { ChatWindow } from './components/ChatWindow';
import { MessageInput } from './components/MessageInput';
import { useChat } from './hooks/useChat';

export default function App() {
  const {
    messages,
    input,
    setInput,
    isSending,
    sendMessage,
    avatarMessageId,
    avatarMood,
    avatarAnalysisStatus,
  } = useChat();

  // TEMPORARY — Phase 4 Step 2. Remove together with AvatarDebugGrid.
  if (window.location.search.includes('avatar-debug')) {
    return <AvatarDebugGrid />;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-4 flex items-center gap-5 rounded-3xl border border-slate-200 bg-white/80 px-6 py-4 shadow-sm backdrop-blur">
        <Avatar
          messageId={avatarMessageId}
          mood={avatarMood}
          analysisStatus={avatarAnalysisStatus}
          size={72}
        />
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-indigo-600">StillWithYou</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Emotional communication assistant</h1>
        </div>
      </header>

      <main className="flex flex-1 flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white/70 p-4 shadow-lg backdrop-blur">
        <ChatWindow messages={messages} />
        <div className="mt-4">
          <MessageInput
            value={input}
            onChange={setInput}
            onSend={() => {
              void sendMessage(input);
            }}
            disabled={isSending}
          />
        </div>
      </main>
    </div>
  );
}

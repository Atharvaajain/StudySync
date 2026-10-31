import { useState } from 'react';
import type { PrototypeIdentity } from '@studysync/shared';
import { JoinScreen } from './components/JoinScreen';
import { RoomScreen } from './components/RoomScreen';
import { clearIdentity, createIdentity, loadIdentity } from './lib/identity';

export function App() {
  const [identity, setIdentity] = useState<PrototypeIdentity | null>(() => loadIdentity());

  if (!identity) {
    return <JoinScreen onJoin={(name) => setIdentity(createIdentity(name))} />;
  }
  return (
    <RoomScreen
      key={identity.userId}
      identity={identity}
      onSwitchUser={() => {
        clearIdentity();
        setIdentity(null);
      }}
    />
  );
}

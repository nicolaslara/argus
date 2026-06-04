import { ReactFlow, Background, Controls, MiniMap, BackgroundVariant } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// M0: the empty fullscreen shell. The canvas is the app; a run renders into it at M3.
export function App() {
  return (
    <div className="argus-app">
      <ReactFlow
        nodes={[]}
        edges={[]}
        colorMode="dark"
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>

      <div className="argus-empty" role="status">
        <div className="argus-wordmark">argus</div>
        <div className="argus-tagline">Claude Code workflow visualizer</div>
        <div className="argus-hint">no run selected</div>
      </div>
    </div>
  );
}

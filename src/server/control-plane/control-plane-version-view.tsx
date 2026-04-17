import { h } from './control-plane-jsx-runtime/jsx-runtime.js';

type VersionStatusSummary = {
  version?: string | null;
  previousVersion?: string | null;
  isNew?: boolean;
  source?: string;
  detail?: string;
};

function VersionStatus({ versionStatus }: { versionStatus: VersionStatusSummary | null }) {
  const version = String(versionStatus && versionStatus.version || '').trim();
  if (!version) {
    return <div className="list-note">Version unavailable.</div>;
  }
  return (
    <div className="queued-prd">
      <div className="item-head">
        <div>
          <div className="pill">Version</div>
          <div className="queue-title">{version}</div>
        </div>
        {versionStatus && versionStatus.isNew ? <span className="pill">New version</span> : null}
      </div>
      {versionStatus && versionStatus.detail ? <div className="queue-detail">{versionStatus.detail}</div> : null}
    </div>
  );
}

export {
  VersionStatus,
};
export type {
  VersionStatusSummary,
};

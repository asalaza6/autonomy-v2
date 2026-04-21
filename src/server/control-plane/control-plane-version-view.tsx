import { h } from './control-plane-jsx-runtime/jsx-runtime.js';

type VersionStatusSummary = {
  version?: string | null;
  previousVersion?: string | null;
  packageVersion?: string | null;
  isNew?: boolean;
  source?: string;
  detail?: string;
};

type PackageStatusSummary = {
  packageName?: string | null;
  installedVersion?: string | null;
  declaredVersion?: string | null;
  packageManager?: string | null;
  status?: string;
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
          <div className="pill">Build</div>
          <div className="queue-title">{version}</div>
        </div>
        {versionStatus && versionStatus.isNew ? <span className="pill">New version</span> : null}
      </div>
      {versionStatus && versionStatus.detail ? <div className="queue-detail">{versionStatus.detail}</div> : null}
    </div>
  );
}

function PackageStatus({ packageStatus }: { packageStatus: PackageStatusSummary | null }) {
  const installedVersion = String(packageStatus && packageStatus.installedVersion || '').trim();
  if (!installedVersion) {
    return <div className="list-note">Installed package version unavailable.</div>;
  }
  const packageName = String(packageStatus && packageStatus.packageName || '@asalaza6/autonomy-v2');
  return (
    <div className="queued-prd">
      <div className="item-head">
        <div>
          <div className="pill">Installed package</div>
          <div className="queue-title">{installedVersion}</div>
        </div>
      </div>
      <div className="queue-detail">
        {[packageName, packageStatus && packageStatus.detail].filter(Boolean).join(' | ')}
      </div>
    </div>
  );
}

export {
  PackageStatus,
  VersionStatus,
};
export type {
  PackageStatusSummary,
  VersionStatusSummary,
};

type Renderable = VNode | Renderable[] | string | number | boolean | null | undefined;

type Props = Record<string, unknown> & {
  children?: Renderable;
  dangerouslySetInnerHTML?: {
    __html?: string;
  };
};

type VNode = {
  type: string | FragmentType | ComponentType;
  props: Props;
  key: string | number | null;
};

type ComponentType = (props: Props) => Renderable;
type FragmentType = symbol;

const Fragment: FragmentType = Symbol.for('managed-site.fragment');

function h(type: VNode['type'], props: Props | null, ...children: Renderable[]) {
  const normalizedChildren = children.length === 0
    ? undefined
    : children.length === 1
      ? children[0]
      : children;

  return {
    type,
    key: null,
    props: {
      ...(props || {}),
      children: normalizedChildren,
    },
  };
}

function renderToHtml(node: Renderable): string {
  if (node == null || node === false || node === true) {
    return '';
  }

  if (Array.isArray(node)) {
    return node.map((child) => renderToHtml(child)).join('');
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return escapeHtml(String(node));
  }

  if (typeof node.type === 'function') {
    return renderToHtml(node.type(node.props || {}));
  }

  if (node.type === Fragment) {
    return renderToHtml(node.props?.children);
  }

  if (typeof node.type !== 'string') {
    return '';
  }

  const props = node.props || {};
  const attributes = renderAttributes(props);
  const rawHtml = props.dangerouslySetInnerHTML && typeof props.dangerouslySetInnerHTML.__html === 'string'
    ? props.dangerouslySetInnerHTML.__html
    : null;
  const innerHtml = rawHtml !== null ? rawHtml : renderToHtml(props.children);

  if (VOID_ELEMENTS.has(node.type)) {
    return `<${node.type}${attributes} />`;
  }

  return `<${node.type}${attributes}>${innerHtml}</${node.type}>`;
}

function renderAttributes(props: Props) {
  const chunks: string[] = [];

  for (const [rawName, rawValue] of Object.entries(props)) {
    if (
      rawName === 'children' ||
      rawName === 'dangerouslySetInnerHTML' ||
      rawName === 'key' ||
      rawName === 'ref' ||
      rawValue == null ||
      rawValue === false ||
      typeof rawValue === 'function'
    ) {
      continue;
    }

    const name = normalizeAttributeName(rawName);

    if (typeof rawValue === 'boolean') {
      if (BOOLEAN_ATTRIBUTES.has(name)) {
        chunks.push(` ${name}`);
      } else {
        chunks.push(` ${name}="true"`);
      }
      continue;
    }

    if (name === 'style' && typeof rawValue === 'object') {
      chunks.push(` style="${escapeHtml(styleObjectToString(rawValue as Record<string, unknown>))}"`);
      continue;
    }

    chunks.push(` ${name}="${escapeHtml(String(rawValue))}"`);
  }

  return chunks.join('');
}

function normalizeAttributeName(name: string) {
  if (name === 'className') {
    return 'class';
  }
  if (name === 'defaultChecked') {
    return 'checked';
  }
  if (name === 'defaultValue') {
    return 'value';
  }
  if (name === 'htmlFor') {
    return 'for';
  }
  if (name === 'charSet') {
    return 'charset';
  }
  if (name === 'tabIndex') {
    return 'tabindex';
  }
  if (name === 'readOnly') {
    return 'readonly';
  }
  if (name === 'autoFocus') {
    return 'autofocus';
  }
  if (name === 'acceptCharset') {
    return 'accept-charset';
  }
  if (name === 'httpEquiv') {
    return 'http-equiv';
  }
  if (name === 'allowFullScreen') {
    return 'allowfullscreen';
  }
  if (name === 'formNoValidate') {
    return 'formnovalidate';
  }
  if (name === 'noValidate') {
    return 'novalidate';
  }
  if (name === 'colSpan') {
    return 'colspan';
  }
  if (name === 'rowSpan') {
    return 'rowspan';
  }
  if (name === 'contentEditable') {
    return 'contenteditable';
  }
  if (name === 'spellCheck') {
    return 'spellcheck';
  }
  if (/^(aria-|data-)/.test(name)) {
    return name;
  }
  return name.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`);
}

function styleObjectToString(style: Record<string, unknown>) {
  return Object.entries(style)
    .filter(([, value]) => value != null && value !== false)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}:${String(value)}`)
    .join(';');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const BOOLEAN_ATTRIBUTES = new Set([
  'allowfullscreen',
  'autofocus',
  'checked',
  'controls',
  'disabled',
  'formnovalidate',
  'hidden',
  'loop',
  'multiple',
  'muted',
  'novalidate',
  'open',
  'readonly',
  'required',
  'selected',
]);

type SiteRecord = {
  id: string;
  name?: string;
  description?: string;
};

type SiteContent = {
  title?: string;
  headline?: string;
  description?: string;
  body?: string;
  footer?: string;
  accent?: string;
};

const pageStyles = {
  page: {
    minHeight: '100vh',
    margin: 0,
    display: 'grid',
    placeItems: 'center',
    color: '#1f1a15',
    background: 'linear-gradient(180deg, #fffaf4 0%, #f7f1ea 100%)',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shell: {
    width: 'min(960px, calc(100vw - 32px))',
    padding: '40px 0 56px',
  },
  card: {
    borderRadius: '28px',
    padding: '28px',
    background: 'rgba(255, 255, 255, 0.88)',
    border: '1px solid rgba(31, 26, 21, 0.12)',
    boxShadow: '0 20px 50px rgba(31, 26, 21, 0.08)',
    backdropFilter: 'blur(10px)',
  },
  eyebrow: {
    color: '#245b75',
    fontSize: '0.8rem',
    fontWeight: 700,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    marginBottom: '14px',
  },
  title: {
    margin: 0,
    fontSize: 'clamp(2rem, 6vw, 4rem)',
    lineHeight: 0.95,
    letterSpacing: '-0.05em',
  },
  body: {
    margin: '16px 0 0',
    color: '#6a6056',
    lineHeight: 1.6,
    fontSize: '1.02rem',
  },
  meta: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap',
    marginTop: '22px',
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderRadius: '999px',
    background: 'rgba(36, 91, 117, 0.12)',
    color: '#245b75',
    fontSize: '0.9rem',
  },
  footer: {
    marginTop: '24px',
    color: '#6a6056',
    fontSize: '0.92rem',
  },
} as const;

function ManagedSitePage({ site, content, port }: { site: SiteRecord; content: SiteContent; port: number }) {
  const title = content.title || site.name || 'Managed site';
  const headline = content.headline || content.title || site.name || 'Managed site';
  const description = content.description || site.description || '';
  const body = content.body || 'Managed by the local manager.';
  const footer = content.footer || 'Managed site template';
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>{title}</title>
      </head>
      <body style={pageStyles.page}>
        <main style={pageStyles.shell}>
          <section style={pageStyles.card}>
            <div style={pageStyles.eyebrow}>Managed site</div>
            <h1 style={pageStyles.title}>{headline}</h1>
            <p style={pageStyles.body}>
              {body}
              {description ? ` ${description}` : ''}
            </p>
            <div style={pageStyles.meta}>
              <span style={pageStyles.pill}>Site: {site.id}</span>
              <span style={pageStyles.pill}>Port: {port}</span>
              <span style={pageStyles.pill}>Health: /healthz</span>
            </div>
            <div style={pageStyles.footer}>{footer}</div>
          </section>
        </main>
      </body>
    </html>
  );
}

function renderPageHtml(site: SiteRecord, content: SiteContent, port: number) {
  return renderToHtml(<ManagedSitePage site={site} content={content} port={port} />);
}

export {
  Fragment,
  ManagedSitePage,
  renderPageHtml,
};

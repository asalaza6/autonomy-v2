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

const Fragment: any = Symbol.for('control-plane.fragment');

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

declare global {
  namespace JSX {
    interface Element extends VNode {}
    interface IntrinsicElements {
      [elementName: string]: Record<string, unknown>;
    }
    interface ElementChildrenAttribute {
      children: {};
    }
  }
}

export {
  Fragment,
  h,
  renderToHtml,
};

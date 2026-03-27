(() => {
  // node_modules/preact/dist/preact.module.js
  var n;
  var l;
  var u;
  var t;
  var i;
  var r;
  var o;
  var e;
  var f;
  var c;
  var s;
  var a;
  var h;
  var p = {};
  var v = [];
  var y = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
  var d = Array.isArray;
  function w(n2, l3) {
    for (var u4 in l3) n2[u4] = l3[u4];
    return n2;
  }
  function g(n2) {
    n2 && n2.parentNode && n2.parentNode.removeChild(n2);
  }
  function _(l3, u4, t3) {
    var i3, r3, o3, e3 = {};
    for (o3 in u4) "key" == o3 ? i3 = u4[o3] : "ref" == o3 ? r3 = u4[o3] : e3[o3] = u4[o3];
    if (arguments.length > 2 && (e3.children = arguments.length > 3 ? n.call(arguments, 2) : t3), "function" == typeof l3 && null != l3.defaultProps) for (o3 in l3.defaultProps) void 0 === e3[o3] && (e3[o3] = l3.defaultProps[o3]);
    return m(l3, e3, i3, r3, null);
  }
  function m(n2, t3, i3, r3, o3) {
    var e3 = { type: n2, props: t3, key: i3, ref: r3, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: null == o3 ? ++u : o3, __i: -1, __u: 0 };
    return null == o3 && null != l.vnode && l.vnode(e3), e3;
  }
  function k(n2) {
    return n2.children;
  }
  function x(n2, l3) {
    this.props = n2, this.context = l3;
  }
  function S(n2, l3) {
    if (null == l3) return n2.__ ? S(n2.__, n2.__i + 1) : null;
    for (var u4; l3 < n2.__k.length; l3++) if (null != (u4 = n2.__k[l3]) && null != u4.__e) return u4.__e;
    return "function" == typeof n2.type ? S(n2) : null;
  }
  function C(n2) {
    if (n2.__P && n2.__d) {
      var u4 = n2.__v, t3 = u4.__e, i3 = [], r3 = [], o3 = w({}, u4);
      o3.__v = u4.__v + 1, l.vnode && l.vnode(o3), z(n2.__P, o3, u4, n2.__n, n2.__P.namespaceURI, 32 & u4.__u ? [t3] : null, i3, null == t3 ? S(u4) : t3, !!(32 & u4.__u), r3), o3.__v = u4.__v, o3.__.__k[o3.__i] = o3, V(i3, o3, r3), u4.__e = u4.__ = null, o3.__e != t3 && M(o3);
    }
  }
  function M(n2) {
    if (null != (n2 = n2.__) && null != n2.__c) return n2.__e = n2.__c.base = null, n2.__k.some(function(l3) {
      if (null != l3 && null != l3.__e) return n2.__e = n2.__c.base = l3.__e;
    }), M(n2);
  }
  function $(n2) {
    (!n2.__d && (n2.__d = true) && i.push(n2) && !I.__r++ || r != l.debounceRendering) && ((r = l.debounceRendering) || o)(I);
  }
  function I() {
    try {
      for (var n2, l3 = 1; i.length; ) i.length > l3 && i.sort(e), n2 = i.shift(), l3 = i.length, C(n2);
    } finally {
      i.length = I.__r = 0;
    }
  }
  function P(n2, l3, u4, t3, i3, r3, o3, e3, f4, c3, s3) {
    var a3, h3, y3, d3, w3, g2, _2, m3 = t3 && t3.__k || v, b = l3.length;
    for (f4 = A(u4, l3, m3, f4, b), a3 = 0; a3 < b; a3++) null != (y3 = u4.__k[a3]) && (h3 = -1 != y3.__i && m3[y3.__i] || p, y3.__i = a3, g2 = z(n2, y3, h3, i3, r3, o3, e3, f4, c3, s3), d3 = y3.__e, y3.ref && h3.ref != y3.ref && (h3.ref && D(h3.ref, null, y3), s3.push(y3.ref, y3.__c || d3, y3)), null == w3 && null != d3 && (w3 = d3), (_2 = !!(4 & y3.__u)) || h3.__k === y3.__k ? f4 = H(y3, f4, n2, _2) : "function" == typeof y3.type && void 0 !== g2 ? f4 = g2 : d3 && (f4 = d3.nextSibling), y3.__u &= -7);
    return u4.__e = w3, f4;
  }
  function A(n2, l3, u4, t3, i3) {
    var r3, o3, e3, f4, c3, s3 = u4.length, a3 = s3, h3 = 0;
    for (n2.__k = new Array(i3), r3 = 0; r3 < i3; r3++) null != (o3 = l3[r3]) && "boolean" != typeof o3 && "function" != typeof o3 ? ("string" == typeof o3 || "number" == typeof o3 || "bigint" == typeof o3 || o3.constructor == String ? o3 = n2.__k[r3] = m(null, o3, null, null, null) : d(o3) ? o3 = n2.__k[r3] = m(k, { children: o3 }, null, null, null) : void 0 === o3.constructor && o3.__b > 0 ? o3 = n2.__k[r3] = m(o3.type, o3.props, o3.key, o3.ref ? o3.ref : null, o3.__v) : n2.__k[r3] = o3, f4 = r3 + h3, o3.__ = n2, o3.__b = n2.__b + 1, e3 = null, -1 != (c3 = o3.__i = T(o3, u4, f4, a3)) && (a3--, (e3 = u4[c3]) && (e3.__u |= 2)), null == e3 || null == e3.__v ? (-1 == c3 && (i3 > s3 ? h3-- : i3 < s3 && h3++), "function" != typeof o3.type && (o3.__u |= 4)) : c3 != f4 && (c3 == f4 - 1 ? h3-- : c3 == f4 + 1 ? h3++ : (c3 > f4 ? h3-- : h3++, o3.__u |= 4))) : n2.__k[r3] = null;
    if (a3) for (r3 = 0; r3 < s3; r3++) null != (e3 = u4[r3]) && 0 == (2 & e3.__u) && (e3.__e == t3 && (t3 = S(e3)), E(e3, e3));
    return t3;
  }
  function H(n2, l3, u4, t3) {
    var i3, r3;
    if ("function" == typeof n2.type) {
      for (i3 = n2.__k, r3 = 0; i3 && r3 < i3.length; r3++) i3[r3] && (i3[r3].__ = n2, l3 = H(i3[r3], l3, u4, t3));
      return l3;
    }
    n2.__e != l3 && (t3 && (l3 && n2.type && !l3.parentNode && (l3 = S(n2)), u4.insertBefore(n2.__e, l3 || null)), l3 = n2.__e);
    do {
      l3 = l3 && l3.nextSibling;
    } while (null != l3 && 8 == l3.nodeType);
    return l3;
  }
  function T(n2, l3, u4, t3) {
    var i3, r3, o3, e3 = n2.key, f4 = n2.type, c3 = l3[u4], s3 = null != c3 && 0 == (2 & c3.__u);
    if (null === c3 && null == e3 || s3 && e3 == c3.key && f4 == c3.type) return u4;
    if (t3 > (s3 ? 1 : 0)) {
      for (i3 = u4 - 1, r3 = u4 + 1; i3 >= 0 || r3 < l3.length; ) if (null != (c3 = l3[o3 = i3 >= 0 ? i3-- : r3++]) && 0 == (2 & c3.__u) && e3 == c3.key && f4 == c3.type) return o3;
    }
    return -1;
  }
  function j(n2, l3, u4) {
    "-" == l3[0] ? n2.setProperty(l3, null == u4 ? "" : u4) : n2[l3] = null == u4 ? "" : "number" != typeof u4 || y.test(l3) ? u4 : u4 + "px";
  }
  function F(n2, l3, u4, t3, i3) {
    var r3, o3;
    n: if ("style" == l3) if ("string" == typeof u4) n2.style.cssText = u4;
    else {
      if ("string" == typeof t3 && (n2.style.cssText = t3 = ""), t3) for (l3 in t3) u4 && l3 in u4 || j(n2.style, l3, "");
      if (u4) for (l3 in u4) t3 && u4[l3] == t3[l3] || j(n2.style, l3, u4[l3]);
    }
    else if ("o" == l3[0] && "n" == l3[1]) r3 = l3 != (l3 = l3.replace(f, "$1")), o3 = l3.toLowerCase(), l3 = o3 in n2 || "onFocusOut" == l3 || "onFocusIn" == l3 ? o3.slice(2) : l3.slice(2), n2.l || (n2.l = {}), n2.l[l3 + r3] = u4, u4 ? t3 ? u4.u = t3.u : (u4.u = c, n2.addEventListener(l3, r3 ? a : s, r3)) : n2.removeEventListener(l3, r3 ? a : s, r3);
    else {
      if ("http://www.w3.org/2000/svg" == i3) l3 = l3.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
      else if ("width" != l3 && "height" != l3 && "href" != l3 && "list" != l3 && "form" != l3 && "tabIndex" != l3 && "download" != l3 && "rowSpan" != l3 && "colSpan" != l3 && "role" != l3 && "popover" != l3 && l3 in n2) try {
        n2[l3] = null == u4 ? "" : u4;
        break n;
      } catch (n3) {
      }
      "function" == typeof u4 || (null == u4 || false === u4 && "-" != l3[4] ? n2.removeAttribute(l3) : n2.setAttribute(l3, "popover" == l3 && 1 == u4 ? "" : u4));
    }
  }
  function O(n2) {
    return function(u4) {
      if (this.l) {
        var t3 = this.l[u4.type + n2];
        if (null == u4.t) u4.t = c++;
        else if (u4.t < t3.u) return;
        return t3(l.event ? l.event(u4) : u4);
      }
    };
  }
  function z(n2, u4, t3, i3, r3, o3, e3, f4, c3, s3) {
    var a3, h3, p3, y3, _2, m3, b, S2, C3, M2, $2, I2, A3, H2, L, T3 = u4.type;
    if (void 0 !== u4.constructor) return null;
    128 & t3.__u && (c3 = !!(32 & t3.__u), o3 = [f4 = u4.__e = t3.__e]), (a3 = l.__b) && a3(u4);
    n: if ("function" == typeof T3) try {
      if (S2 = u4.props, C3 = T3.prototype && T3.prototype.render, M2 = (a3 = T3.contextType) && i3[a3.__c], $2 = a3 ? M2 ? M2.props.value : a3.__ : i3, t3.__c ? b = (h3 = u4.__c = t3.__c).__ = h3.__E : (C3 ? u4.__c = h3 = new T3(S2, $2) : (u4.__c = h3 = new x(S2, $2), h3.constructor = T3, h3.render = G), M2 && M2.sub(h3), h3.state || (h3.state = {}), h3.__n = i3, p3 = h3.__d = true, h3.__h = [], h3._sb = []), C3 && null == h3.__s && (h3.__s = h3.state), C3 && null != T3.getDerivedStateFromProps && (h3.__s == h3.state && (h3.__s = w({}, h3.__s)), w(h3.__s, T3.getDerivedStateFromProps(S2, h3.__s))), y3 = h3.props, _2 = h3.state, h3.__v = u4, p3) C3 && null == T3.getDerivedStateFromProps && null != h3.componentWillMount && h3.componentWillMount(), C3 && null != h3.componentDidMount && h3.__h.push(h3.componentDidMount);
      else {
        if (C3 && null == T3.getDerivedStateFromProps && S2 !== y3 && null != h3.componentWillReceiveProps && h3.componentWillReceiveProps(S2, $2), u4.__v == t3.__v || !h3.__e && null != h3.shouldComponentUpdate && false === h3.shouldComponentUpdate(S2, h3.__s, $2)) {
          u4.__v != t3.__v && (h3.props = S2, h3.state = h3.__s, h3.__d = false), u4.__e = t3.__e, u4.__k = t3.__k, u4.__k.some(function(n3) {
            n3 && (n3.__ = u4);
          }), v.push.apply(h3.__h, h3._sb), h3._sb = [], h3.__h.length && e3.push(h3);
          break n;
        }
        null != h3.componentWillUpdate && h3.componentWillUpdate(S2, h3.__s, $2), C3 && null != h3.componentDidUpdate && h3.__h.push(function() {
          h3.componentDidUpdate(y3, _2, m3);
        });
      }
      if (h3.context = $2, h3.props = S2, h3.__P = n2, h3.__e = false, I2 = l.__r, A3 = 0, C3) h3.state = h3.__s, h3.__d = false, I2 && I2(u4), a3 = h3.render(h3.props, h3.state, h3.context), v.push.apply(h3.__h, h3._sb), h3._sb = [];
      else do {
        h3.__d = false, I2 && I2(u4), a3 = h3.render(h3.props, h3.state, h3.context), h3.state = h3.__s;
      } while (h3.__d && ++A3 < 25);
      h3.state = h3.__s, null != h3.getChildContext && (i3 = w(w({}, i3), h3.getChildContext())), C3 && !p3 && null != h3.getSnapshotBeforeUpdate && (m3 = h3.getSnapshotBeforeUpdate(y3, _2)), H2 = null != a3 && a3.type === k && null == a3.key ? q(a3.props.children) : a3, f4 = P(n2, d(H2) ? H2 : [H2], u4, t3, i3, r3, o3, e3, f4, c3, s3), h3.base = u4.__e, u4.__u &= -161, h3.__h.length && e3.push(h3), b && (h3.__E = h3.__ = null);
    } catch (n3) {
      if (u4.__v = null, c3 || null != o3) if (n3.then) {
        for (u4.__u |= c3 ? 160 : 128; f4 && 8 == f4.nodeType && f4.nextSibling; ) f4 = f4.nextSibling;
        o3[o3.indexOf(f4)] = null, u4.__e = f4;
      } else {
        for (L = o3.length; L--; ) g(o3[L]);
        N(u4);
      }
      else u4.__e = t3.__e, u4.__k = t3.__k, n3.then || N(u4);
      l.__e(n3, u4, t3);
    }
    else null == o3 && u4.__v == t3.__v ? (u4.__k = t3.__k, u4.__e = t3.__e) : f4 = u4.__e = B(t3.__e, u4, t3, i3, r3, o3, e3, c3, s3);
    return (a3 = l.diffed) && a3(u4), 128 & u4.__u ? void 0 : f4;
  }
  function N(n2) {
    n2 && (n2.__c && (n2.__c.__e = true), n2.__k && n2.__k.some(N));
  }
  function V(n2, u4, t3) {
    for (var i3 = 0; i3 < t3.length; i3++) D(t3[i3], t3[++i3], t3[++i3]);
    l.__c && l.__c(u4, n2), n2.some(function(u5) {
      try {
        n2 = u5.__h, u5.__h = [], n2.some(function(n3) {
          n3.call(u5);
        });
      } catch (n3) {
        l.__e(n3, u5.__v);
      }
    });
  }
  function q(n2) {
    return "object" != typeof n2 || null == n2 || n2.__b > 0 ? n2 : d(n2) ? n2.map(q) : w({}, n2);
  }
  function B(u4, t3, i3, r3, o3, e3, f4, c3, s3) {
    var a3, h3, v3, y3, w3, _2, m3, b = i3.props || p, k3 = t3.props, x2 = t3.type;
    if ("svg" == x2 ? o3 = "http://www.w3.org/2000/svg" : "math" == x2 ? o3 = "http://www.w3.org/1998/Math/MathML" : o3 || (o3 = "http://www.w3.org/1999/xhtml"), null != e3) {
      for (a3 = 0; a3 < e3.length; a3++) if ((w3 = e3[a3]) && "setAttribute" in w3 == !!x2 && (x2 ? w3.localName == x2 : 3 == w3.nodeType)) {
        u4 = w3, e3[a3] = null;
        break;
      }
    }
    if (null == u4) {
      if (null == x2) return document.createTextNode(k3);
      u4 = document.createElementNS(o3, x2, k3.is && k3), c3 && (l.__m && l.__m(t3, e3), c3 = false), e3 = null;
    }
    if (null == x2) b === k3 || c3 && u4.data == k3 || (u4.data = k3);
    else {
      if (e3 = e3 && n.call(u4.childNodes), !c3 && null != e3) for (b = {}, a3 = 0; a3 < u4.attributes.length; a3++) b[(w3 = u4.attributes[a3]).name] = w3.value;
      for (a3 in b) w3 = b[a3], "dangerouslySetInnerHTML" == a3 ? v3 = w3 : "children" == a3 || a3 in k3 || "value" == a3 && "defaultValue" in k3 || "checked" == a3 && "defaultChecked" in k3 || F(u4, a3, null, w3, o3);
      for (a3 in k3) w3 = k3[a3], "children" == a3 ? y3 = w3 : "dangerouslySetInnerHTML" == a3 ? h3 = w3 : "value" == a3 ? _2 = w3 : "checked" == a3 ? m3 = w3 : c3 && "function" != typeof w3 || b[a3] === w3 || F(u4, a3, w3, b[a3], o3);
      if (h3) c3 || v3 && (h3.__html == v3.__html || h3.__html == u4.innerHTML) || (u4.innerHTML = h3.__html), t3.__k = [];
      else if (v3 && (u4.innerHTML = ""), P("template" == t3.type ? u4.content : u4, d(y3) ? y3 : [y3], t3, i3, r3, "foreignObject" == x2 ? "http://www.w3.org/1999/xhtml" : o3, e3, f4, e3 ? e3[0] : i3.__k && S(i3, 0), c3, s3), null != e3) for (a3 = e3.length; a3--; ) g(e3[a3]);
      c3 || (a3 = "value", "progress" == x2 && null == _2 ? u4.removeAttribute("value") : null != _2 && (_2 !== u4[a3] || "progress" == x2 && !_2 || "option" == x2 && _2 != b[a3]) && F(u4, a3, _2, b[a3], o3), a3 = "checked", null != m3 && m3 != u4[a3] && F(u4, a3, m3, b[a3], o3));
    }
    return u4;
  }
  function D(n2, u4, t3) {
    try {
      if ("function" == typeof n2) {
        var i3 = "function" == typeof n2.__u;
        i3 && n2.__u(), i3 && null == u4 || (n2.__u = n2(u4));
      } else n2.current = u4;
    } catch (n3) {
      l.__e(n3, t3);
    }
  }
  function E(n2, u4, t3) {
    var i3, r3;
    if (l.unmount && l.unmount(n2), (i3 = n2.ref) && (i3.current && i3.current != n2.__e || D(i3, null, u4)), null != (i3 = n2.__c)) {
      if (i3.componentWillUnmount) try {
        i3.componentWillUnmount();
      } catch (n3) {
        l.__e(n3, u4);
      }
      i3.base = i3.__P = null;
    }
    if (i3 = n2.__k) for (r3 = 0; r3 < i3.length; r3++) i3[r3] && E(i3[r3], u4, t3 || "function" != typeof n2.type);
    t3 || g(n2.__e), n2.__c = n2.__ = n2.__e = void 0;
  }
  function G(n2, l3, u4) {
    return this.constructor(n2, u4);
  }
  function J(u4, t3, i3) {
    var r3, o3, e3, f4;
    t3 == document && (t3 = document.documentElement), l.__ && l.__(u4, t3), o3 = (r3 = "function" == typeof i3) ? null : i3 && i3.__k || t3.__k, e3 = [], f4 = [], z(t3, u4 = (!r3 && i3 || t3).__k = _(k, null, [u4]), o3 || p, p, t3.namespaceURI, !r3 && i3 ? [i3] : o3 ? null : t3.firstChild ? n.call(t3.childNodes) : null, e3, !r3 && i3 ? i3 : o3 ? o3.__e : t3.firstChild, r3, f4), V(e3, u4, f4);
  }
  n = v.slice, l = { __e: function(n2, l3, u4, t3) {
    for (var i3, r3, o3; l3 = l3.__; ) if ((i3 = l3.__c) && !i3.__) try {
      if ((r3 = i3.constructor) && null != r3.getDerivedStateFromError && (i3.setState(r3.getDerivedStateFromError(n2)), o3 = i3.__d), null != i3.componentDidCatch && (i3.componentDidCatch(n2, t3 || {}), o3 = i3.__d), o3) return i3.__E = i3;
    } catch (l4) {
      n2 = l4;
    }
    throw n2;
  } }, u = 0, t = function(n2) {
    return null != n2 && void 0 === n2.constructor;
  }, x.prototype.setState = function(n2, l3) {
    var u4;
    u4 = null != this.__s && this.__s != this.state ? this.__s : this.__s = w({}, this.state), "function" == typeof n2 && (n2 = n2(w({}, u4), this.props)), n2 && w(u4, n2), null != n2 && this.__v && (l3 && this._sb.push(l3), $(this));
  }, x.prototype.forceUpdate = function(n2) {
    this.__v && (this.__e = true, n2 && this.__h.push(n2), $(this));
  }, x.prototype.render = k, i = [], o = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e = function(n2, l3) {
    return n2.__v.__b - l3.__v.__b;
  }, I.__r = 0, f = /(PointerCapture)$|Capture$/i, c = 0, s = O(false), a = O(true), h = 0;

  // node_modules/preact/hooks/dist/hooks.module.js
  var t2;
  var r2;
  var u2;
  var i2;
  var o2 = 0;
  var f2 = [];
  var c2 = l;
  var e2 = c2.__b;
  var a2 = c2.__r;
  var v2 = c2.diffed;
  var l2 = c2.__c;
  var m2 = c2.unmount;
  var s2 = c2.__;
  function p2(n2, t3) {
    c2.__h && c2.__h(r2, n2, o2 || t3), o2 = 0;
    var u4 = r2.__H || (r2.__H = { __: [], __h: [] });
    return n2 >= u4.__.length && u4.__.push({}), u4.__[n2];
  }
  function d2(n2) {
    return o2 = 1, h2(D2, n2);
  }
  function h2(n2, u4, i3) {
    var o3 = p2(t2++, 2);
    if (o3.t = n2, !o3.__c && (o3.__ = [i3 ? i3(u4) : D2(void 0, u4), function(n3) {
      var t3 = o3.__N ? o3.__N[0] : o3.__[0], r3 = o3.t(t3, n3);
      t3 !== r3 && (o3.__N = [r3, o3.__[1]], o3.__c.setState({}));
    }], o3.__c = r2, !r2.__f)) {
      var f4 = function(n3, t3, r3) {
        if (!o3.__c.__H) return true;
        var u5 = o3.__c.__H.__.filter(function(n4) {
          return n4.__c;
        });
        if (u5.every(function(n4) {
          return !n4.__N;
        })) return !c3 || c3.call(this, n3, t3, r3);
        var i4 = o3.__c.props !== n3;
        return u5.some(function(n4) {
          if (n4.__N) {
            var t4 = n4.__[0];
            n4.__ = n4.__N, n4.__N = void 0, t4 !== n4.__[0] && (i4 = true);
          }
        }), c3 && c3.call(this, n3, t3, r3) || i4;
      };
      r2.__f = true;
      var c3 = r2.shouldComponentUpdate, e3 = r2.componentWillUpdate;
      r2.componentWillUpdate = function(n3, t3, r3) {
        if (this.__e) {
          var u5 = c3;
          c3 = void 0, f4(n3, t3, r3), c3 = u5;
        }
        e3 && e3.call(this, n3, t3, r3);
      }, r2.shouldComponentUpdate = f4;
    }
    return o3.__N || o3.__;
  }
  function y2(n2, u4) {
    var i3 = p2(t2++, 3);
    !c2.__s && C2(i3.__H, u4) && (i3.__ = n2, i3.u = u4, r2.__H.__h.push(i3));
  }
  function A2(n2) {
    return o2 = 5, T2(function() {
      return { current: n2 };
    }, []);
  }
  function T2(n2, r3) {
    var u4 = p2(t2++, 7);
    return C2(u4.__H, r3) && (u4.__ = n2(), u4.__H = r3, u4.__h = n2), u4.__;
  }
  function j2() {
    for (var n2; n2 = f2.shift(); ) {
      var t3 = n2.__H;
      if (n2.__P && t3) try {
        t3.__h.some(z2), t3.__h.some(B2), t3.__h = [];
      } catch (r3) {
        t3.__h = [], c2.__e(r3, n2.__v);
      }
    }
  }
  c2.__b = function(n2) {
    r2 = null, e2 && e2(n2);
  }, c2.__ = function(n2, t3) {
    n2 && t3.__k && t3.__k.__m && (n2.__m = t3.__k.__m), s2 && s2(n2, t3);
  }, c2.__r = function(n2) {
    a2 && a2(n2), t2 = 0;
    var i3 = (r2 = n2.__c).__H;
    i3 && (u2 === r2 ? (i3.__h = [], r2.__h = [], i3.__.some(function(n3) {
      n3.__N && (n3.__ = n3.__N), n3.u = n3.__N = void 0;
    })) : (i3.__h.some(z2), i3.__h.some(B2), i3.__h = [], t2 = 0)), u2 = r2;
  }, c2.diffed = function(n2) {
    v2 && v2(n2);
    var t3 = n2.__c;
    t3 && t3.__H && (t3.__H.__h.length && (1 !== f2.push(t3) && i2 === c2.requestAnimationFrame || ((i2 = c2.requestAnimationFrame) || w2)(j2)), t3.__H.__.some(function(n3) {
      n3.u && (n3.__H = n3.u), n3.u = void 0;
    })), u2 = r2 = null;
  }, c2.__c = function(n2, t3) {
    t3.some(function(n3) {
      try {
        n3.__h.some(z2), n3.__h = n3.__h.filter(function(n4) {
          return !n4.__ || B2(n4);
        });
      } catch (r3) {
        t3.some(function(n4) {
          n4.__h && (n4.__h = []);
        }), t3 = [], c2.__e(r3, n3.__v);
      }
    }), l2 && l2(n2, t3);
  }, c2.unmount = function(n2) {
    m2 && m2(n2);
    var t3, r3 = n2.__c;
    r3 && r3.__H && (r3.__H.__.some(function(n3) {
      try {
        z2(n3);
      } catch (n4) {
        t3 = n4;
      }
    }), r3.__H = void 0, t3 && c2.__e(t3, r3.__v));
  };
  var k2 = "function" == typeof requestAnimationFrame;
  function w2(n2) {
    var t3, r3 = function() {
      clearTimeout(u4), k2 && cancelAnimationFrame(t3), setTimeout(n2);
    }, u4 = setTimeout(r3, 35);
    k2 && (t3 = requestAnimationFrame(r3));
  }
  function z2(n2) {
    var t3 = r2, u4 = n2.__c;
    "function" == typeof u4 && (n2.__c = void 0, u4()), r2 = t3;
  }
  function B2(n2) {
    var t3 = r2;
    n2.__c = n2.__(), r2 = t3;
  }
  function C2(n2, t3) {
    return !n2 || n2.length !== t3.length || t3.some(function(t4, r3) {
      return t4 !== n2[r3];
    });
  }
  function D2(n2, t3) {
    return "function" == typeof t3 ? t3(n2) : t3;
  }

  // node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js
  var f3 = 0;
  function u3(e3, t3, n2, o3, i3, u4) {
    t3 || (t3 = {});
    var a3, c3, p3 = t3;
    if ("ref" in p3) for (c3 in p3 = {}, t3) "ref" == c3 ? a3 = t3[c3] : p3[c3] = t3[c3];
    var l3 = { type: e3, props: p3, key: n2, ref: a3, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: --f3, __i: -1, __u: 0, __source: i3, __self: u4 };
    if ("function" == typeof e3 && (a3 = e3.defaultProps)) for (c3 in a3) void 0 === p3[c3] && (p3[c3] = a3[c3]);
    return l.vnode && l.vnode(l3), l3;
  }

  // tools/export-graph-app.tsx
  var styles = `
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    color-scheme: light;
    --bg: #f8fafc;
    --panel: rgba(255, 255, 255, 0.82);
    --panel-solid: #ffffff;
    --panel-muted: #f8fafc;
    --line: #cbd5e1;
    --line-strong: #94a3b8;
    --text: #0f172a;
    --muted: #475569;
    --accent: #2563eb;
    --shadow: 0 16px 48px rgba(15, 23, 42, 0.08);
    --radius-lg: 18px;
    --radius-md: 14px;
    --radius-sm: 10px;
    --mono: "SF Mono", "Menlo", monospace;
    --sans: "Inter", "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
  }

  body {
    margin: 0;
    min-height: 100vh;
    font-family: var(--sans);
    background:
      radial-gradient(circle at top left, rgba(59, 130, 246, 0.08), transparent 30%),
      linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%);
  }

  button, input, select, textarea { font: inherit; }

  .page {
    width: min(1560px, 100%);
    margin: 0 auto;
    padding: clamp(12px, 1.8vw, 28px);
  }

  .meta {
    margin-bottom: 16px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel);
    backdrop-filter: blur(10px);
  }

  .graph-shell {
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .graph-stage {
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  .graph-shell.tree-mode .graph-stage {
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  }

  .graph-toolbar {
    display: grid;
    gap: 12px;
    align-items: start;
    margin-bottom: 12px;
  }

  .toolbar-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .graph-toolbar button {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
    color: var(--text);
    padding: 6px 12px;
    cursor: pointer;
  }

  .graph-toolbar button:hover {
    background: var(--panel-muted);
  }

  .toolbar-spacer {
    margin-left: auto;
  }

  .toolbar-status {
    color: var(--muted);
    font-size: 12px;
    font-family: var(--mono);
  }

  .root-controls {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 4px;
  }

  .root-strip {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    white-space: nowrap;
  }

  .root-button {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    background: #fff;
    cursor: pointer;
  }

  .root-button.active {
    background: #e2e8f0;
    border-color: #334155;
  }

  .graph-frame {
    width: 100%;
    min-height: 520px;
    max-height: calc(100vh - 240px);
    overflow: auto;
    white-space: nowrap;
    border: 1px dashed var(--line);
    border-radius: var(--radius-md);
    scrollbar-width: thin;
    overscroll-behavior: contain;
  }

  .mermaid-container {
    width: 100%;
    min-width: 100%;
    max-width: 100%;
    overflow: visible;
    padding: 4px 0 4px 2px;
  }

  .mermaid-content {
    display: inline-block;
    width: auto;
    min-width: 100%;
    transform-origin: top left;
    transition: transform 120ms ease;
    overflow: visible;
  }

  .mermaid {
    display: block;
    width: auto;
    max-width: 100% !important;
    overflow: visible;
  }

  .mermaid svg {
    display: block;
    width: auto !important;
    max-width: 100% !important;
    height: auto;
  }

  .analytics-panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel-muted);
    padding: 12px;
    max-height: calc(100vh - 240px);
    overflow: auto;
  }

  .analytics-panel h2 {
    margin: 0 0 10px;
    font-size: 13px;
    line-height: 1.2;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: #334155;
  }

  .analytics-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }

  .analytics-chip {
    border: 1px solid var(--line);
    border-radius: 999px;
    background: #fff;
    padding: 4px 8px;
    font-size: 12px;
    color: var(--muted);
  }

  .analytics-grid {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) 72px 72px 56px;
    gap: 4px 6px;
    align-items: center;
  }

  .analytics-head {
    appearance: none;
    border: 0;
    background: transparent;
    padding: 0 0 8px;
    text-align: left;
    cursor: pointer;
    position: relative;
    font-size: 11px;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--line);
    margin-bottom: 2px;
  }

  .analytics-row { display: contents; }

  .analytics-cell {
    min-width: 0;
    font-size: 11px;
    line-height: 1.15;
  }

  .analytics-depth, .analytics-number {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .analytics-number {
    padding-left: 2px;
    position: relative;
  }

  .analytics-file {
    position: relative;
    overflow: visible;
    color: var(--text);
    padding-right: 8px;
  }

  .analytics-file-label {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .analytics-count {
    display: inline-block;
    min-width: 1ch;
  }

  .analytics-tooltip {
    position: absolute;
    left: 0;
    top: calc(100% + 8px);
    z-index: 20;
    display: none;
    min-width: 180px;
    max-width: 320px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #fff;
    color: var(--text);
    box-shadow: 0 16px 32px rgba(15, 23, 42, 0.16);
    text-transform: none;
    letter-spacing: normal;
    font-weight: 500;
    white-space: normal;
  }

  .analytics-file .analytics-tooltip {
    min-width: 320px;
    max-width: 520px;
  }

  .analytics-sort:hover .analytics-tooltip,
  .analytics-sort:focus-visible .analytics-tooltip,
  .analytics-number:hover .analytics-tooltip,
  .analytics-number:focus-within .analytics-tooltip,
  .analytics-file:hover .analytics-tooltip,
  .analytics-file:focus-within .analytics-tooltip {
    display: block;
  }

  .analytics-tooltip strong,
  .analytics-tooltip-label {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #334155;
  }

  .analytics-tooltip ul {
    margin: 8px 0 0;
    padding: 0 0 0 16px;
  }

  .analytics-tooltip li {
    margin: 0 0 2px;
  }

  .analytics-tooltip-path {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .analytics-tooltip-depth {
    color: #64748b;
    font-variant-numeric: tabular-nums;
  }

  .error {
    padding: 12px;
    color: #b91c1c;
    white-space: pre-wrap;
    font-family: var(--mono);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 980px) {
    .graph-shell.tree-mode .graph-stage {
      grid-template-columns: 1fr;
    }

    .analytics-panel {
      max-height: 420px;
    }
  }

  @media (max-width: 720px) {
    .page {
      padding: 12px;
    }

    .graph-shell {
      padding: 12px;
      border-radius: 14px;
    }

    .graph-frame {
      min-height: 440px;
      max-height: calc(100vh - 220px);
    }

    .toolbar-row {
      align-items: stretch;
    }

    .toolbar-spacer {
      display: none;
    }

    .toolbar-status {
      width: 100%;
      text-align: right;
    }

    .root-strip {
      flex-wrap: nowrap;
    }
  }
`;
  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
  function escapeMermaidLabel(value) {
    return escapeHtml(value);
  }
  function sanitizeId(value) {
    return String(value ?? "").replaceAll(/[^a-zA-Z0-9_]/g, "_");
  }
  function getFileName(filePath) {
    const normalizedPath = String(filePath ?? "").replaceAll("\\", "/");
    const segments = normalizedPath.split("/");
    return segments[segments.length - 1] || normalizedPath;
  }
  function loadMermaid(init) {
    return new Promise((resolve, reject) => {
      if (window.mermaid) {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          maxEdges: 5e3,
          maxTextSize: 1e6,
          ...init
        });
        resolve(window.mermaid);
        return;
      }
      const existing = document.querySelector('script[data-mermaid-loader="true"]');
      if (existing) {
        existing.addEventListener("load", () => {
          if (!window.mermaid) {
            reject(new Error("Mermaid loaded without a global runtime."));
            return;
          }
          window.mermaid.initialize({
            startOnLoad: false,
            theme: "neutral",
            maxEdges: 5e3,
            maxTextSize: 1e6,
            ...init
          });
          resolve(window.mermaid);
        }, { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Mermaid.")), {
          once: true
        });
        return;
      }
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
      script.async = true;
      script.dataset.mermaidLoader = "true";
      script.addEventListener("load", () => {
        if (!window.mermaid) {
          reject(new Error("Mermaid loaded without a global runtime."));
          return;
        }
        window.mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          maxEdges: 5e3,
          maxTextSize: 1e6,
          ...init
        });
        resolve(window.mermaid);
      }, { once: true });
      script.addEventListener("error", () => reject(new Error("Failed to load Mermaid.")), {
        once: true
      });
      document.head.appendChild(script);
    });
  }
  function compareAnalyticsRows(left, right, sort) {
    const direction = sort.direction === "desc" ? -1 : 1;
    let comparison = 0;
    if (sort.key === "file") {
      comparison = left.label.localeCompare(right.label) || left.path.localeCompare(right.path) || left.id.localeCompare(right.id);
    } else {
      comparison = (left[sort.key] ?? 0) - (right[sort.key] ?? 0);
      if (comparison === 0 && sort.key !== "depth") {
        comparison = left.depth - right.depth;
      }
      if (comparison === 0) {
        comparison = left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
      }
    }
    return comparison * direction;
  }
  function buildVisibleTreeGraph(treeGridData, rootFileId = "all") {
    const fileById = new Map(treeGridData.files.map((entry) => [entry.id, entry]));
    const allFileIds = new Set(fileById.keys());
    const selectedRootId = rootFileId === "all" ? "all" : rootFileId && allFileIds.has(rootFileId) ? rootFileId : treeGridData.roots[0] ?? "all";
    const visibleFiles = /* @__PURE__ */ new Set();
    if (selectedRootId !== "all") {
      const queue = [selectedRootId];
      while (queue.length > 0) {
        const source = queue.shift();
        if (!source || visibleFiles.has(source)) {
          continue;
        }
        visibleFiles.add(source);
        treeGridData.edges.forEach(({ source: edgeSource, target }) => {
          if (edgeSource === source && allFileIds.has(target) && !visibleFiles.has(target)) {
            queue.push(target);
          }
        });
      }
    } else {
      allFileIds.forEach((fileId) => {
        visibleFiles.add(fileId);
      });
    }
    const filteredEdges = treeGridData.edges.filter(
      ({ source, target }) => visibleFiles.has(source) && visibleFiles.has(target)
    );
    return {
      selectedRootId,
      fileById,
      visibleFiles,
      filteredEdges
    };
  }
  function buildCondensedDepthLevels(visibleFiles, filteredEdges) {
    const outgoingByFile = /* @__PURE__ */ new Map();
    visibleFiles.forEach((fileId) => {
      outgoingByFile.set(fileId, []);
    });
    filteredEdges.forEach(({ source, target }) => {
      const outgoing = outgoingByFile.get(source);
      if (!outgoing) {
        return;
      }
      outgoing.push(target);
    });
    outgoingByFile.forEach((targets) => {
      targets.sort();
    });
    const indexByFile = /* @__PURE__ */ new Map();
    const lowLinkByFile = /* @__PURE__ */ new Map();
    const componentByFile = /* @__PURE__ */ new Map();
    const stack = [];
    const stackMembers = /* @__PURE__ */ new Set();
    const components = [];
    let currentIndex = 0;
    function strongConnect(fileId) {
      indexByFile.set(fileId, currentIndex);
      lowLinkByFile.set(fileId, currentIndex);
      currentIndex += 1;
      stack.push(fileId);
      stackMembers.add(fileId);
      (outgoingByFile.get(fileId) ?? []).forEach((targetId) => {
        if (!indexByFile.has(targetId)) {
          strongConnect(targetId);
          lowLinkByFile.set(
            fileId,
            Math.min(lowLinkByFile.get(fileId) ?? 0, lowLinkByFile.get(targetId) ?? 0)
          );
          return;
        }
        if (stackMembers.has(targetId)) {
          lowLinkByFile.set(
            fileId,
            Math.min(lowLinkByFile.get(fileId) ?? 0, indexByFile.get(targetId) ?? 0)
          );
        }
      });
      if (lowLinkByFile.get(fileId) !== indexByFile.get(fileId)) {
        return;
      }
      const componentId = components.length;
      const members = [];
      while (stack.length > 0) {
        const member = stack.pop();
        if (!member) {
          break;
        }
        stackMembers.delete(member);
        componentByFile.set(member, componentId);
        members.push(member);
        if (member === fileId) {
          break;
        }
      }
      components.push(members.sort());
    }
    Array.from(visibleFiles).sort().forEach((fileId) => {
      if (!indexByFile.has(fileId)) {
        strongConnect(fileId);
      }
    });
    const outgoingByComponent = /* @__PURE__ */ new Map();
    const incomingCounts = /* @__PURE__ */ new Map();
    components.forEach((_2, componentId) => {
      outgoingByComponent.set(componentId, /* @__PURE__ */ new Set());
      incomingCounts.set(componentId, 0);
    });
    filteredEdges.forEach(({ source, target }) => {
      const sourceComponent = componentByFile.get(source);
      const targetComponent = componentByFile.get(target);
      if (sourceComponent === void 0 || targetComponent === void 0 || sourceComponent === targetComponent) {
        return;
      }
      const targets = outgoingByComponent.get(sourceComponent);
      if (!targets || targets.has(targetComponent)) {
        return;
      }
      targets.add(targetComponent);
      incomingCounts.set(targetComponent, (incomingCounts.get(targetComponent) ?? 0) + 1);
    });
    const levelByComponent = /* @__PURE__ */ new Map();
    let frontier = Array.from(incomingCounts.entries()).filter(([, incoming]) => incoming === 0).map(([componentId]) => componentId).sort((left, right) => left - right);
    frontier.forEach((componentId) => {
      levelByComponent.set(componentId, 0);
    });
    const remainingIncoming = new Map(incomingCounts);
    while (frontier.length > 0) {
      const nextFrontier = [];
      frontier.forEach((sourceComponent) => {
        const sourceLevel = levelByComponent.get(sourceComponent);
        if (sourceLevel === void 0) {
          return;
        }
        Array.from(outgoingByComponent.get(sourceComponent) ?? []).sort((left, right) => left - right).forEach((targetComponent) => {
          const nextLevel = sourceLevel + 1;
          const existing = levelByComponent.get(targetComponent);
          if (existing === void 0 || nextLevel > existing) {
            levelByComponent.set(targetComponent, nextLevel);
          }
          const updated = Math.max(0, (remainingIncoming.get(targetComponent) ?? 0) - 1);
          remainingIncoming.set(targetComponent, updated);
          if (updated === 0) {
            nextFrontier.push(targetComponent);
          }
        });
      });
      frontier = [...new Set(nextFrontier)].sort((left, right) => left - right);
    }
    const levelByFile = /* @__PURE__ */ new Map();
    componentByFile.forEach((componentId, fileId) => {
      const level = levelByComponent.get(componentId);
      if (level === void 0) {
        throw new Error(`Missing component level for ${fileId}.`);
      }
      levelByFile.set(fileId, level);
    });
    return levelByFile;
  }
  function buildTreeDepthState(treeGridData, rootFileId = "all") {
    const { selectedRootId, fileById, filteredEdges, visibleFiles } = buildVisibleTreeGraph(
      treeGridData,
      rootFileId
    );
    const levelByFile = buildCondensedDepthLevels(visibleFiles, filteredEdges);
    return {
      selectedRootId,
      fileById,
      visibleFiles,
      filteredEdges,
      levelByFile
    };
  }
  function buildTreeViewState(treeGridData, rootFileId, sort) {
    const { selectedRootId, fileById, filteredEdges, levelByFile, visibleFiles } = buildTreeDepthState(
      treeGridData,
      rootFileId
    );
    const visiblePaths = Array.from(visibleFiles).map((fileId) => fileById.get(fileId)?.path ?? null).filter((value) => Boolean(value)).sort();
    const fileLookup = new Map(treeGridData.files.map((entry) => [entry.path, entry]));
    const levels = /* @__PURE__ */ new Map();
    for (const [fileId, level] of levelByFile.entries()) {
      const file = fileById.get(fileId);
      if (!file) {
        continue;
      }
      const entries = levels.get(level) ?? [];
      entries.push(file.path);
      levels.set(level, entries);
    }
    const fileRows = Array.from(visibleFiles).map((fileId) => {
      const file = fileById.get(fileId);
      if (!file) {
        return null;
      }
      return {
        id: file.id,
        path: file.path,
        label: file.label,
        depth: levelByFile.get(file.id) ?? 0,
        imports: Array.from(new Set(file.imports ?? [])).sort(),
        importPaths: [],
        exportPaths: [],
        negativeImports: 0,
        negativeExports: 0,
        balance: 0,
        negativeImportFiles: [],
        negativeExportFiles: [],
        balanceFiles: []
      };
    }).filter((entry) => Boolean(entry));
    const fileRowsByPath = new Map(fileRows.map((row) => [row.path, row]));
    fileRows.forEach((sourceRow) => {
      sourceRow.imports.forEach((importedPath) => {
        const targetRow = fileRowsByPath.get(importedPath);
        if (!targetRow) {
          return;
        }
        sourceRow.importPaths.push(targetRow.path);
        targetRow.exportPaths.push(sourceRow.path);
        const currentDepth = sourceRow.depth;
        const importDepth = targetRow.depth;
        const exportDepth = sourceRow.depth;
        const exportedCurrentDepth = targetRow.depth;
        if (importDepth < currentDepth) {
          sourceRow.negativeImports += 1;
          sourceRow.negativeImportFiles.push(targetRow.path);
        }
        if (exportDepth > exportedCurrentDepth) {
          targetRow.negativeExports += 1;
          targetRow.negativeExportFiles.push(sourceRow.path);
        }
        if (exportDepth === exportedCurrentDepth) {
          sourceRow.balance += 1;
          sourceRow.balanceFiles.push(targetRow.path);
        }
      });
    });
    fileRows.forEach((row) => {
      row.importPaths = Array.from(new Set(row.importPaths)).sort();
      row.exportPaths = Array.from(new Set(row.exportPaths)).sort();
      row.negativeImportFiles = Array.from(new Set(row.negativeImportFiles)).sort();
      row.negativeExportFiles = Array.from(new Set(row.negativeExportFiles)).sort();
      row.balanceFiles = Array.from(new Set(row.balanceFiles)).sort();
    });
    fileRows.sort((left, right) => compareAnalyticsRows(left, right, sort));
    return {
      selectedRootId,
      levelByFile,
      visibleFiles,
      filteredEdges,
      visiblePaths,
      fileLookup,
      levels,
      fileRows,
      maxDepth: fileRows.reduce((max, entry) => Math.max(max, entry.depth), 0)
    };
  }
  function buildTreeMermaid(treeGridData, state) {
    const lines = [
      `%% ${state.visiblePaths.length} files, ${treeGridData.files.length} total files, ${state.filteredEdges.length} edges`,
      "flowchart TD",
      "direction TB",
      "classDef fileNode fill:#e2e8f0,stroke:#334155,stroke-width:1px,color:#0f172a;",
      "classDef fileRoot fill:#f8fafc,stroke:#0f172a,stroke-width:1px,color:#0f172a,stroke-dasharray: 3 3;"
    ];
    Array.from(state.levels.keys()).sort((left, right) => left - right).forEach((level) => {
      lines.push(`subgraph file_level_${level}["Depth ${level}"]`);
      lines.push("direction TB");
      const filesInLevel = state.levels.get(level) ?? [];
      filesInLevel.sort().forEach((filePath) => {
        const file = state.fileLookup.get(filePath);
        if (!file) {
          return;
        }
        lines.push(`${sanitizeId(file.id)}["${escapeMermaidLabel(getFileName(filePath))}"]`);
      });
      lines.push("end");
    });
    Array.from(state.visibleFiles).forEach((fileId) => {
      if ((state.levelByFile.get(fileId) ?? 0) === 0) {
        lines.push(`class ${sanitizeId(fileId)} fileRoot;`);
        return;
      }
      lines.push(`class ${sanitizeId(fileId)} fileNode;`);
    });
    Array.from(
      new Set(state.filteredEdges.map(({ source, target }) => `${sanitizeId(source)}=>${sanitizeId(target)}`))
    ).sort().forEach((edgeId) => {
      const [source, target] = edgeId.split("=>");
      if (source && target) {
        lines.push(`${source} --> ${target}`);
      }
    });
    return lines.join("\n");
  }
  function tooltipList(files) {
    const uniqueFiles = [...new Set(files.filter(Boolean))].sort();
    if (uniqueFiles.length === 0) {
      return /* @__PURE__ */ u3("div", { children: "None" });
    }
    return /* @__PURE__ */ u3("ul", { children: uniqueFiles.map((filePath) => /* @__PURE__ */ u3("li", { children: getFileName(filePath) }, filePath)) });
  }
  function popoverList(files, rowsByPath) {
    const entries = files.map((filePath) => {
      const entry = rowsByPath.get(filePath);
      if (!entry) {
        return null;
      }
      return { path: filePath, depth: entry.depth };
    }).filter((entry) => Boolean(entry)).sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path));
    if (entries.length === 0) {
      return /* @__PURE__ */ u3("div", { children: "None" });
    }
    return /* @__PURE__ */ u3("ul", { children: entries.map((entry) => /* @__PURE__ */ u3("li", { children: [
      /* @__PURE__ */ u3("span", { class: "analytics-tooltip-path", children: entry.path }),
      " ",
      /* @__PURE__ */ u3("span", { class: "analytics-tooltip-depth", children: [
        "(D",
        entry.depth,
        ")"
      ] })
    ] }, entry.path)) });
  }
  function App({ payload: payload2 }) {
    const graphFrameRef = A2(null);
    const mermaidContentRef = A2(null);
    const mermaidDiagramRef = A2(null);
    const scaleRef = A2(1);
    const autoFitRef = A2(false);
    const [mermaidApi, setMermaidApi] = d2(null);
    const [mermaidError, setMermaidError] = d2(null);
    const [currentScale, setCurrentScale] = d2(1);
    const [activeRoot, setActiveRoot] = d2(
      payload2.useTree && payload2.treeGridData?.roots.length ? payload2.treeGridData.roots[0] : "all"
    );
    const [sort, setSort] = d2({ key: "depth", direction: "asc" });
    y2(() => {
      loadMermaid(payload2.mermaidInit).then((api) => {
        setMermaidApi(api);
      }).catch((error) => {
        setMermaidError(
          error instanceof Error ? error.message : "Mermaid failed to load. Check network access or open this file in a browser with internet access."
        );
      });
    }, [payload2.mermaidInit]);
    const treeState = payload2.useTree && payload2.treeGridData ? buildTreeViewState(payload2.treeGridData, activeRoot, sort) : null;
    const diagramDefinition = payload2.useTree && payload2.treeGridData && treeState ? buildTreeMermaid(payload2.treeGridData, treeState) : payload2.mermaidDefinition;
    function clampScale(value) {
      return Math.max(0.08, value);
    }
    function getDiagramWidth() {
      const svg = mermaidDiagramRef.current?.querySelector("svg");
      if (!svg) {
        return 0;
      }
      const renderedWidth = svg.getBoundingClientRect().width || svg.clientWidth || 0;
      if (renderedWidth > 0) {
        return renderedWidth;
      }
      if (svg.viewBox?.baseVal?.width) {
        return svg.viewBox.baseVal.width;
      }
      return 0;
    }
    function getDiagramHeight() {
      const svg = mermaidDiagramRef.current?.querySelector("svg");
      if (!svg) {
        return 0;
      }
      if (svg.viewBox?.baseVal?.height) {
        return svg.viewBox.baseVal.height;
      }
      return svg.getBoundingClientRect().height || svg.clientHeight || 0;
    }
    function renderZoom(level, labelValue = null) {
      const scale = clampScale(level);
      scaleRef.current = scale;
      setCurrentScale(scale);
      if (mermaidContentRef.current) {
        mermaidContentRef.current.style.transform = `scale(${scale})`;
        const height = getDiagramHeight();
        if (height > 0) {
          mermaidContentRef.current.style.minHeight = `${Math.ceil(height * scale)}px`;
        }
      }
      if (labelValue !== null) {
        const zoomLevel = document.getElementById("zoomLevel");
        if (zoomLevel) {
          zoomLevel.textContent = labelValue;
        }
      }
    }
    function centerGraphView() {
      const graphFrame = graphFrameRef.current;
      if (!graphFrame) {
        return;
      }
      requestAnimationFrame(() => {
        const maxScrollLeft = Math.max(0, graphFrame.scrollWidth - graphFrame.clientWidth);
        graphFrame.scrollLeft = maxScrollLeft / 2;
        graphFrame.scrollTop = 0;
      });
    }
    function getRenderedNode(nodeId) {
      const root2 = mermaidDiagramRef.current;
      if (!root2 || !nodeId) {
        return null;
      }
      const selectors = [`#${nodeId}`, `[data-id="${nodeId}"]`, `[id="${nodeId}"]`];
      for (const selector of selectors) {
        const node = root2.querySelector(selector);
        if (node) {
          return node;
        }
      }
      return null;
    }
    function centerRootNode(rootId) {
      const graphFrame = graphFrameRef.current;
      if (!graphFrame) {
        return;
      }
      if (!rootId || rootId === "all") {
        centerGraphView();
        return;
      }
      requestAnimationFrame(() => {
        const node = getRenderedNode(sanitizeId(rootId));
        if (!node) {
          centerGraphView();
          return;
        }
        const frameRect = graphFrame.getBoundingClientRect();
        const nodeRect = node.getBoundingClientRect();
        const frameCenterX = frameRect.left + frameRect.width / 2;
        const nodeCenterX = nodeRect.left + nodeRect.width / 2;
        const scrollDeltaX = (nodeCenterX - frameCenterX) / (scaleRef.current || 1);
        graphFrame.scrollLeft = Math.max(0, graphFrame.scrollLeft + scrollDeltaX);
        graphFrame.scrollTop = 0;
      });
    }
    function fitToWidth() {
      const graphFrame = graphFrameRef.current;
      const zoomLevel = document.getElementById("zoomLevel");
      const diagramWidth = getDiagramWidth();
      if (!graphFrame || !diagramWidth) {
        return;
      }
      const frameWidth = graphFrame.clientWidth - 24;
      const nextScale = Math.min(1, frameWidth / diagramWidth);
      autoFitRef.current = true;
      renderZoom(nextScale);
      if (zoomLevel) {
        zoomLevel.textContent = "Fit";
      }
      centerRootNode(activeRoot);
    }
    y2(() => {
      if (!mermaidApi || !mermaidDiagramRef.current) {
        return;
      }
      const diagram = mermaidDiagramRef.current;
      diagram.textContent = diagramDefinition;
      diagram.style.display = "block";
      diagram.style.width = "auto";
      diagram.removeAttribute("data-processed");
      setMermaidError(null);
      mermaidApi.run({ nodes: [diagram] }).then(() => {
        requestAnimationFrame(() => {
          renderZoom(scaleRef.current);
          if (autoFitRef.current) {
            fitToWidth();
          } else {
            centerRootNode(activeRoot);
          }
        });
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setMermaidError(`Mermaid render error: ${message}`);
      });
    }, [activeRoot, diagramDefinition, mermaidApi]);
    y2(() => {
      const graphFrame = graphFrameRef.current;
      if (!graphFrame) {
        return;
      }
      const onWheel = (event) => {
        if (!event.ctrlKey) {
          return;
        }
        event.preventDefault();
        autoFitRef.current = false;
        const pinchFactor = Math.exp(-event.deltaY * 15e-4);
        renderZoom(scaleRef.current * pinchFactor);
      };
      graphFrame.addEventListener("wheel", onWheel, { passive: false });
      return () => {
        graphFrame.removeEventListener("wheel", onWheel);
      };
    }, []);
    y2(() => {
      const onResize = () => {
        if (autoFitRef.current) {
          fitToWidth();
        }
      };
      window.addEventListener("resize", onResize);
      return () => {
        window.removeEventListener("resize", onResize);
      };
    }, [activeRoot]);
    y2(() => {
      if (payload2.useTree) {
        autoFitRef.current = true;
      }
    }, [payload2.useTree]);
    const zoomLabel = `${Math.round(currentScale * 100)}%`;
    const rowsByPath = new Map((treeState?.fileRows ?? []).map((row) => [row.path, row]));
    y2(() => {
      window.__EXPORT_GRAPH_DEBUG__ = {
        activeRoot,
        sort,
        treeState,
        buildTreeDepthState
      };
      return () => {
        delete window.__EXPORT_GRAPH_DEBUG__;
      };
    }, [activeRoot, sort, treeState]);
    return /* @__PURE__ */ u3(k, { children: [
      /* @__PURE__ */ u3("style", { children: styles }),
      /* @__PURE__ */ u3("main", { class: "page", children: [
        /* @__PURE__ */ u3("div", { class: "meta", children: [
          payload2.stats.exports,
          " exports, ",
          payload2.stats.importers,
          " importers, ",
          payload2.stats.edges,
          " edges"
        ] }),
        /* @__PURE__ */ u3("section", { class: `graph-shell${payload2.useTree ? " tree-mode" : ""}`, children: [
          /* @__PURE__ */ u3("div", { class: "graph-toolbar", children: [
            payload2.useTree && payload2.treeGridData ? /* @__PURE__ */ u3("div", { class: "root-controls", children: /* @__PURE__ */ u3("div", { class: "root-strip", children: [
              /* @__PURE__ */ u3(
                "button",
                {
                  type: "button",
                  class: `root-button${activeRoot === "all" ? " active" : ""}`,
                  onClick: () => {
                    autoFitRef.current = false;
                    setActiveRoot("all");
                  },
                  children: "All Files"
                }
              ),
              payload2.treeGridData.roots.map((rootId) => {
                const file = payload2.treeGridData?.files.find((entry) => entry.id === rootId);
                if (!file) {
                  return null;
                }
                return /* @__PURE__ */ u3(
                  "button",
                  {
                    type: "button",
                    class: `root-button${activeRoot === rootId ? " active" : ""}`,
                    onClick: () => {
                      autoFitRef.current = false;
                      setActiveRoot(rootId);
                    },
                    children: file.label
                  },
                  rootId
                );
              })
            ] }) }) : null,
            /* @__PURE__ */ u3("div", { class: "toolbar-row", children: [
              /* @__PURE__ */ u3(
                "button",
                {
                  id: "zoomFit",
                  type: "button",
                  onClick: () => {
                    fitToWidth();
                  },
                  children: "Fit width"
                }
              ),
              /* @__PURE__ */ u3(
                "button",
                {
                  id: "zoomOut",
                  type: "button",
                  onClick: () => {
                    autoFitRef.current = false;
                    renderZoom(scaleRef.current - 0.1);
                  },
                  children: "\u2212"
                }
              ),
              /* @__PURE__ */ u3(
                "button",
                {
                  id: "zoomIn",
                  type: "button",
                  onClick: () => {
                    autoFitRef.current = false;
                    renderZoom(scaleRef.current + 0.1);
                  },
                  children: "\uFF0B"
                }
              ),
              /* @__PURE__ */ u3(
                "button",
                {
                  id: "zoomReset",
                  type: "button",
                  onClick: () => {
                    autoFitRef.current = false;
                    renderZoom(1);
                  },
                  children: "100%"
                }
              ),
              /* @__PURE__ */ u3("span", { class: "toolbar-spacer" }),
              /* @__PURE__ */ u3("span", { id: "zoomLevel", class: "toolbar-status", children: zoomLabel }),
              /* @__PURE__ */ u3("span", { class: "sr-only", "aria-live": "polite", id: "zoomStatus" })
            ] })
          ] }),
          /* @__PURE__ */ u3("div", { class: "graph-stage", children: [
            /* @__PURE__ */ u3("div", { ref: graphFrameRef, class: "graph-frame", children: /* @__PURE__ */ u3("div", { class: "mermaid-container", children: /* @__PURE__ */ u3("div", { ref: mermaidContentRef, class: "mermaid-content", children: [
              /* @__PURE__ */ u3("div", { ref: mermaidDiagramRef, class: "mermaid" }),
              mermaidError ? /* @__PURE__ */ u3("pre", { class: "error", children: mermaidError }) : null
            ] }) }) }),
            payload2.useTree && treeState ? /* @__PURE__ */ u3("aside", { class: "analytics-panel", "aria-label": "Depth analytics", children: [
              /* @__PURE__ */ u3("h2", { children: "Depth Analytics" }),
              /* @__PURE__ */ u3("div", { class: "analytics-summary", children: [
                /* @__PURE__ */ u3("span", { class: "analytics-chip", children: [
                  treeState.fileRows.length,
                  " files"
                ] }),
                /* @__PURE__ */ u3("span", { class: "analytics-chip", children: [
                  treeState.filteredEdges.length,
                  " edges"
                ] }),
                /* @__PURE__ */ u3("span", { class: "analytics-chip", children: [
                  "Max depth ",
                  treeState.maxDepth
                ] })
              ] }),
              /* @__PURE__ */ u3("div", { class: "analytics-grid", role: "table", "aria-label": "Files ordered by depth", children: [
                [
                  [
                    "depth",
                    "D",
                    "Depth of the file in the current tree. Lower numbers are closer to the root."
                  ],
                  ["file", "File", "The file name for each visible node in the tree."],
                  [
                    "negativeImports",
                    "NI",
                    "Negative imports. Counts this file's imports to files at a higher depth number."
                  ],
                  [
                    "negativeExports",
                    "NE",
                    "Negative exports. Counts lower-depth files that import this file from above."
                  ],
                  ["balance", "B", "Balanced links. Counts imports from files at the same depth."]
                ].map(([key, label, explanation]) => {
                  const isActive = sort.key === key;
                  const suffix = isActive ? sort.direction === "asc" ? " \u2191" : " \u2193" : "";
                  return /* @__PURE__ */ u3(
                    "button",
                    {
                      type: "button",
                      class: "analytics-head analytics-sort",
                      "aria-label": `${label}: ${explanation}`,
                      onClick: () => {
                        if (sort.key === key) {
                          setSort({
                            key,
                            direction: sort.direction === "asc" ? "desc" : "asc"
                          });
                          return;
                        }
                        setSort({
                          key,
                          direction: key === "file" ? "asc" : "desc"
                        });
                      },
                      children: [
                        label,
                        suffix,
                        /* @__PURE__ */ u3("span", { class: "analytics-tooltip", children: [
                          /* @__PURE__ */ u3("strong", { children: label }),
                          explanation
                        ] })
                      ]
                    },
                    key
                  );
                }),
                treeState.fileRows.map((row) => /* @__PURE__ */ u3("div", { class: "analytics-row", children: [
                  /* @__PURE__ */ u3("div", { class: "analytics-cell analytics-depth", children: row.depth }),
                  /* @__PURE__ */ u3("div", { class: "analytics-cell analytics-file", title: row.path, children: [
                    /* @__PURE__ */ u3("span", { class: "analytics-file-label", children: row.label }),
                    /* @__PURE__ */ u3("span", { class: "analytics-tooltip", children: [
                      /* @__PURE__ */ u3("div", { class: "analytics-tooltip-section", children: [
                        /* @__PURE__ */ u3("strong", { class: "analytics-tooltip-label", children: "Imports" }),
                        popoverList(row.importPaths, rowsByPath)
                      ] }),
                      /* @__PURE__ */ u3("div", { class: "analytics-tooltip-section", children: [
                        /* @__PURE__ */ u3("strong", { class: "analytics-tooltip-label", children: "Exports" }),
                        popoverList(row.exportPaths, rowsByPath)
                      ] })
                    ] })
                  ] }),
                  /* @__PURE__ */ u3("div", { class: "analytics-cell analytics-number", children: [
                    /* @__PURE__ */ u3("span", { class: "analytics-count", title: getFileName(row.path), children: row.negativeImports }),
                    /* @__PURE__ */ u3("span", { class: "analytics-tooltip", children: tooltipList(row.negativeImportFiles) })
                  ] }),
                  /* @__PURE__ */ u3("div", { class: "analytics-cell analytics-number", children: [
                    /* @__PURE__ */ u3("span", { class: "analytics-count", title: getFileName(row.path), children: row.negativeExports }),
                    /* @__PURE__ */ u3("span", { class: "analytics-tooltip", children: tooltipList(row.negativeExportFiles) })
                  ] }),
                  /* @__PURE__ */ u3("div", { class: "analytics-cell analytics-number", children: [
                    /* @__PURE__ */ u3("span", { class: "analytics-count", title: getFileName(row.path), children: row.balance }),
                    /* @__PURE__ */ u3("span", { class: "analytics-tooltip", children: tooltipList(row.balanceFiles) })
                  ] })
                ] }, row.id))
              ] })
            ] }) : null
          ] })
        ] })
      ] })
    ] });
  }
  var payload = window.__EXPORT_GRAPH_DATA__;
  if (!payload) {
    throw new Error("Missing export graph payload.");
  }
  var root = document.getElementById("app");
  if (!root) {
    throw new Error("Missing app root.");
  }
  J(/* @__PURE__ */ u3(App, { payload }), root);
})();

//# sourceMappingURL=export-graph.app.js.map

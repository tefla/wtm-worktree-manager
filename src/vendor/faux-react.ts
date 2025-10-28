export type ReactNode = ReactElement | string | number | boolean | null | undefined;

export interface ReactElement {
  type: ElementType;
  props: Record<string, any> & { children: ReactNode[] };
}

export type ElementType = string | Function | typeof FragmentSymbol;

interface StateHook<T> {
  kind: "state";
  value: T;
}

interface MemoHook<T> {
  kind: "memo";
  value: T;
  deps?: any[];
}

interface RefHook<T> {
  kind: "ref";
  ref: { current: T };
}

interface EffectHook {
  kind: "effect";
  deps?: any[];
  cleanup?: (() => void) | undefined;
}

type HookRecord = StateHook<unknown> | MemoHook<unknown> | RefHook<any> | EffectHook;

interface PendingEffect {
  index: number;
  deps?: any[];
  effect: () => void | (() => void);
  cleanup?: (() => void) | undefined;
}

interface ComponentInstance {
  hooks: HookRecord[];
  hookCursor: number;
  pendingEffects: PendingEffect[];
  seen: boolean;
}

type EffectRunner = () => void;

const instanceMap = new Map<string, ComponentInstance>();
let currentInstance: ComponentInstance | null = null;
let scheduleUpdate: (() => void) | null = null;
let currentRootElement: ReactNode = null;
let rootContainer: Element | null = null;

const FragmentSymbol = Symbol("Fragment");

function isHookOfKind<T extends HookRecord["kind"]>(hook: HookRecord | undefined, kind: T): hook is Extract<HookRecord, { kind: T }> {
  return Boolean(hook && hook.kind === kind);
}

function flattenChildren(children: any[]): ReactNode[] {
  const result: ReactNode[] = [];
  const stack = [...children];
  while (stack.length > 0) {
    const value = stack.shift();
    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }
    if (value === false || value === null || value === undefined) {
      continue;
    }
    result.push(value);
  }
  return result;
}

export function createElement(type: ElementType, props: Record<string, any> | null, ...rawChildren: any[]): ReactElement {
  const normalizedProps = { ...(props ?? {}) } as Record<string, any> & { children: ReactNode[] };
  normalizedProps.children = flattenChildren(rawChildren);
  return { type, props: normalizedProps };
}

export const Fragment = FragmentSymbol;

function ensureInstance(path: string): ComponentInstance {
  const existing = instanceMap.get(path);
  if (existing) {
    existing.seen = true;
    existing.hookCursor = 0;
    existing.pendingEffects = [];
    return existing;
  }
  const instance: ComponentInstance = {
    hooks: [],
    hookCursor: 0,
    pendingEffects: [],
    seen: true,
  };
  instanceMap.set(path, instance);
  return instance;
}

function runPendingEffects(instance: ComponentInstance) {
  for (const pending of instance.pendingEffects) {
    if (pending.cleanup) {
      try {
        pending.cleanup();
      } catch (error) {
        console.error("Effect cleanup failed", error);
      }
    }
    let cleanup: (() => void) | void;
    try {
      cleanup = pending.effect();
    } catch (error) {
      console.error("Effect execution failed", error);
      cleanup = undefined;
    }
    instance.hooks[pending.index] = {
      kind: "effect",
      deps: pending.deps,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    } satisfies EffectHook;
  }
  instance.pendingEffects = [];
}

function cleanupStaleInstances() {
  for (const [key, instance] of instanceMap.entries()) {
    if (instance.seen) {
      instance.seen = false;
      continue;
    }
    for (const hook of instance.hooks) {
      if (isHookOfKind(hook, "effect") && hook.cleanup) {
        try {
          hook.cleanup();
        } catch (error) {
          console.error("Effect cleanup failed", error);
        }
      }
    }
    instanceMap.delete(key);
  }
}

function renderChildren(children: ReactNode[], parent: Element | DocumentFragment, path: string, effects: EffectRunner[]) {
  children.forEach((child, index) => {
    renderNode(child, parent, `${path}.${index}`, effects);
  });
}

function renderNode(node: ReactNode, parent: Element | DocumentFragment, path: string, effects: EffectRunner[]) {
  if (node === null || node === undefined || node === false) {
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    parent.appendChild(document.createTextNode(String(node)));
    return;
  }
  if (Array.isArray(node)) {
    renderChildren(node, parent, path, effects);
    return;
  }
  const element = node as ReactElement;
  if (element.type === FragmentSymbol) {
    renderChildren(element.props.children ?? [], parent, path, effects);
    return;
  }
  if (typeof element.type === "function") {
    const instance = ensureInstance(path);
    currentInstance = instance;
    const rendered = element.type(element.props);
    currentInstance = null;
    renderNode(rendered as ReactNode, parent, `${path}.c`, effects);
    effects.push(() => runPendingEffects(instance));
    return;
  }
  const domElement = document.createElement(element.type);
  for (const [key, value] of Object.entries(element.props)) {
    if (key === "children") continue;
    if (value === null || value === undefined || value === false) continue;
    if (key === "className") {
      domElement.setAttribute("class", String(value));
      continue;
    }
    if (key === "style" && typeof value === "object") {
      Object.assign(domElement.style, value);
      continue;
    }
    if (key.startsWith("on") && typeof value === "function") {
      const eventName = key.slice(2).toLowerCase();
      domElement.addEventListener(eventName, value as EventListener);
      continue;
    }
    try {
      if (key in domElement) {
        (domElement as any)[key] = value;
      } else {
        domElement.setAttribute(key, String(value));
      }
    } catch {
      domElement.setAttribute(key, String(value));
    }
  }
  renderChildren(element.props.children ?? [], domElement, path, effects);
  parent.appendChild(domElement);
}

function mount(element: ReactNode) {
  if (!rootContainer) return;
  currentRootElement = element;
  instanceMap.forEach((instance) => {
    instance.seen = false;
  });
  while (rootContainer.firstChild) {
    rootContainer.removeChild(rootContainer.firstChild);
  }
  const effects: EffectRunner[] = [];
  renderNode(element, rootContainer, "0", effects);
  cleanupStaleInstances();
  effects.forEach((runner) => runner());
}

export function useState<T>(initialValue: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void] {
  if (!currentInstance) {
    throw new Error("useState called outside of component render");
  }
  const index = currentInstance.hookCursor++;
  const instance = currentInstance;
  let record = instance.hooks[index];
  if (!isHookOfKind(record, "state")) {
    const value = typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
    record = { kind: "state", value } satisfies StateHook<T>;
    instance.hooks[index] = record;
  }
  const setState = (next: T | ((prev: T) => T)) => {
    const currentRecord = instance.hooks[index] as StateHook<T>;
    const previous = currentRecord.value as T;
    const nextValue = typeof next === "function" ? (next as (prev: T) => T)(previous) : next;
    if (Object.is(nextValue, previous)) {
      return;
    }
    currentRecord.value = nextValue;
    if (scheduleUpdate) {
      scheduleUpdate();
    }
  };
  return [(record as StateHook<T>).value as T, setState];
}

export function useMemo<T>(factory: () => T, deps?: any[]): T {
  if (!currentInstance) {
    throw new Error("useMemo called outside of component render");
  }
  const index = currentInstance.hookCursor++;
  let record = currentInstance.hooks[index];
  if (!isHookOfKind(record, "memo")) {
    const value = factory();
    record = { kind: "memo", value, deps } satisfies MemoHook<T>;
    currentInstance.hooks[index] = record;
    return value;
  }
  const memoRecord = record as MemoHook<T>;
  if (!deps || !memoRecord.deps || deps.some((dep, i) => !Object.is(dep, memoRecord.deps?.[i]))) {
    const value = factory();
    memoRecord.value = value;
    memoRecord.deps = deps;
    return value;
  }
  return memoRecord.value as T;
}

export function useCallback<T extends (...args: any[]) => any>(callback: T, deps?: any[]): T {
  return useMemo(() => callback, deps);
}

export function useRef<T>(initialValue: T): { current: T } {
  if (!currentInstance) {
    throw new Error("useRef called outside of component render");
  }
  const index = currentInstance.hookCursor++;
  let record = currentInstance.hooks[index];
  if (!isHookOfKind(record, "ref")) {
    record = { kind: "ref", ref: { current: initialValue } } satisfies RefHook<T>;
    currentInstance.hooks[index] = record;
  }
  return (record as RefHook<T>).ref;
}

export function useEffect(effect: () => void | (() => void), deps?: any[]) {
  if (!currentInstance) {
    throw new Error("useEffect called outside of component render");
  }
  const index = currentInstance.hookCursor++;
  const previous = currentInstance.hooks[index];
  const previousDeps = isHookOfKind(previous, "effect") ? previous.deps : undefined;
  const hasChanged = !previousDeps || !deps || deps.some((dep, i) => !Object.is(dep, previousDeps[i]));
  if (hasChanged) {
    currentInstance.pendingEffects.push({
      index,
      deps,
      effect,
      cleanup: isHookOfKind(previous, "effect") ? previous.cleanup : undefined,
    });
  }
  if (!isHookOfKind(previous, "effect")) {
    currentInstance.hooks[index] = { kind: "effect", deps } satisfies EffectHook;
  }
}

export function createRoot(container: Element) {
  rootContainer = container;
  return {
    render(element: ReactNode) {
      scheduleUpdate = () => {
        mount(currentRootElement);
      };
      mount(element);
    },
  };
}

export default {
  createElement,
  Fragment,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
};

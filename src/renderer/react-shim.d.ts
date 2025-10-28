declare module "react" {
  export type ReactNode = any;
  export interface FunctionComponent<P = {}> {
    (props: P & { children?: ReactNode }): ReactNode;
  }
  export interface MutableRefObject<T> {
    current: T;
  }
  export interface SyntheticEvent<T = Element> extends Event {
    currentTarget: T;
    target: T;
    preventDefault(): void;
    stopPropagation(): void;
  }
  export interface FormEvent<T = Element> extends SyntheticEvent<T> {}
  export type FC<P = {}> = FunctionComponent<P>;
  export const Fragment: unique symbol;
  export function createElement(type: any, props: any, ...children: any[]): ReactNode;
  export function useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: any[]): void;
  export function useMemo<T>(factory: () => T, deps?: any[]): T;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps?: any[]): T;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export { FormEvent };
}

declare namespace JSX {
  interface IntrinsicElements {
    [element: string]: any;
  }
  type Element = any;
}

declare module "react-dom/client" {
  export function createRoot(container: Element): { render(element: any): void };
}

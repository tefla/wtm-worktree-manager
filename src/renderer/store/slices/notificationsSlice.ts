import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Toast, ToastKind } from "../types";

export interface NotificationsState {
  toasts: Toast[];
}

const initialState: NotificationsState = {
  toasts: [],
};

const notificationsSlice = createSlice({
  name: "notifications",
  initialState,
  reducers: {
    setToastList(state, action: PayloadAction<Toast[]>) {
      state.toasts = action.payload;
    },
    addToast(state, action: PayloadAction<Toast>) {
      state.toasts.push(action.payload);
    },
    removeToast(state, action: PayloadAction<number>) {
      state.toasts = state.toasts.filter((toast) => toast.id !== action.payload);
    },
    clearToasts(state) {
      state.toasts = [];
    },
  },
});

export const { setToastList, addToast, removeToast, clearToasts } = notificationsSlice.actions;

export const notificationsReducer = notificationsSlice.reducer;

export const selectNotificationsState = (state: { notifications: NotificationsState }) => state.notifications;

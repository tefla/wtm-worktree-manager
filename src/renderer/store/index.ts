import { configureStore } from "@reduxjs/toolkit";
import { workspaceReducer } from "./slices/workspacesSlice";
import { projectReducer } from "./slices/projectSlice";
import { settingsReducer } from "./slices/settingsSlice";
import { jiraReducer } from "./slices/jiraSlice";
import { notificationsReducer } from "./slices/notificationsSlice";

export const store = configureStore({
  reducer: {
    workspaces: workspaceReducer,
    project: projectReducer,
    settings: settingsReducer,
    jira: jiraReducer,
    notifications: notificationsReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

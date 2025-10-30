import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { JiraTicketSummary } from "../../../shared/jira";

export interface JiraState {
  tickets: JiraTicketSummary[];
}

const initialState: JiraState = {
  tickets: [],
};

const jiraSlice = createSlice({
  name: "jira",
  initialState,
  reducers: {
    setJiraTickets(state, action: PayloadAction<JiraTicketSummary[]>) {
      state.tickets = action.payload;
    },
  },
});

export const { setJiraTickets } = jiraSlice.actions;

export const jiraReducer = jiraSlice.reducer;

export const selectJiraState = (state: { jira: JiraState }) => state.jira;

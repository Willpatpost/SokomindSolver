import { useReducer } from "react";
import {
  createInitialState,
  editorReducer,
  type EditorAction,
  type EditorState,
} from "./editor-model";

export function useEditorState(): [EditorState, (action: EditorAction) => void] {
  return useReducer(editorReducer, undefined, createInitialState);
}

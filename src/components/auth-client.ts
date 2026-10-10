"use client";
import { createAuthClient } from "better-auth/react";
// Relative URLs keep cookies and requests on the current shop origin.
export const authClient = createAuthClient();

/**
 * DamSafe Twin — Error Boundary
 * Catches rendering errors and shows a recovery UI instead of a white screen.
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('DamSafe ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="card border-red-200 bg-red-50">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-red-500 mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-800">
                {this.props.fallbackLabel || 'Component Error'}
              </h3>
              <p className="text-xs text-red-600 mt-1">
                {this.state.error?.message || 'An unexpected error occurred'}
              </p>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="mt-3 flex items-center gap-1 text-xs font-medium text-red-700 hover:text-red-900"
              >
                <RefreshCw className="w-3 h-3" /> Try Again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

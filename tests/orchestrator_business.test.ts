import { describe, expect, it } from 'vitest';
import { controlTask, createTask, listAgents } from '../server/agents/orchestrator.js';
import {
  createBusinessRecord,
  evaluateDecisionMatrix,
  getBusinessSummary,
  runDigitalTwinSimulation,
} from '../server/business/businessService.js';
import { pairDevice, revokeDevice, verifyDeviceToken } from '../server/devices/deviceService.js';
import { analyzeProject } from '../server/engineering/engineerService.js';

describe('Multi-Agent Orchestrator, Engineering, Business & Devices', () => {
  it('seeds all 13 specialized agents', () => {
    const agents = listAgents();
    expect(agents.length).toBe(13);
    expect(agents.map((a) => a.role)).toContain('bug_hunter');
    expect(agents.map((a) => a.role)).toContain('independent_reviewer');
  });

  it('creates a multi-step task and supports cancellation', () => {
    const task = createTask({
      title: 'Vitest orchestrated check',
      goal: 'Inspect system health and workspace',
      autoStart: false,
    });
    expect(task.steps?.length).toBeGreaterThanOrEqual(2);
    const cancelled = controlTask(task.id, 'cancel');
    expect(cancelled?.status).toBe('cancelled');
  });

  it('analyzes the current TypeScript/React/Express workspace accurately', async () => {
    const analysis = await analyzeProject('.');
    expect(analysis.language).toBe('TypeScript');
    expect(analysis.framework).toContain('React');
    expect(analysis.fileCount).toBeGreaterThan(5);
  });

  it('computes real business ledger arithmetic without invented data', () => {
    createBusinessRecord({
      domain: 'finance',
      recordType: 'revenue',
      title: 'Test Client Retainer',
      amount: 2500,
    });
    createBusinessRecord({
      domain: 'finance',
      recordType: 'expense',
      title: 'Server Hosting',
      amount: 300,
    });
    const summary = getBusinessSummary();
    expect(summary.recordedRevenue).toBeGreaterThanOrEqual(2500);
    expect(summary.recordedExpenses).toBeGreaterThanOrEqual(300);
    expect(summary.netCashFlow).toBe(
      Math.round((summary.recordedRevenue - summary.recordedExpenses) * 100) / 100
    );
  });

  it('evaluates numerical decision matrices and labels simulations as predictions', () => {
    const decision = evaluateDecisionMatrix('Pick model size', [
      { name: '3B Q4', cost: 0, timeHours: 1, riskScore: 2, benefitScore: 8, reversible: true },
      { name: '70B', cost: 500, timeHours: 10, riskScore: 9, benefitScore: 5, reversible: false },
    ]);
    expect(decision.recommended).toBe('3B Q4');
    expect(decision.fallback).toBe('70B');

    const sim = runDigitalTwinSimulation({
      domain: 'operations',
      scenarioName: 'Cache optimization',
      assumptions: { monthlyCost: 500, expectedLiftPercent: 20, complexityFactor: 1.1 },
    });
    expect(sim.isPrediction).toBe(true);
    expect(sim.predictedOutcome).toContain('SIMULATION PREDICTION');
  });

  it('pairs devices with scrypt-verified tokens and supports revocation', () => {
    const paired = pairDevice({
      name: 'Android Test Phone',
      platform: 'android',
      deviceType: 'mobile',
      capabilities: ['voice', 'chat'],
    });
    expect(verifyDeviceToken(paired.device.id, paired.pairingToken)).toBe(true);
    expect(verifyDeviceToken(paired.device.id, 'wrong-token')).toBe(false);
    expect(revokeDevice(paired.device.id)).toBe(true);
    expect(verifyDeviceToken(paired.device.id, paired.pairingToken)).toBe(false);
  });
});

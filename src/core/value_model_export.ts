import type { ValueModelSnapshot } from './value_model_snapshot';

function formatNumber(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toFixed(digits)).toString();
}

export function exportValueModelJson(snapshot: ValueModelSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function exportValueModelTs(snapshot: ValueModelSnapshot): string {
  return `export const VALUE_MODEL = {
  enabled: ${snapshot.enabled},
  featureNames: ${JSON.stringify(snapshot.featureNames)},
  weights: ${JSON.stringify(snapshot.weights.map(v => Number(v.toFixed(6))))},
  bias: ${formatNumber(snapshot.bias, 6)},
  trainedAt: ${JSON.stringify(snapshot.trainedAt)},
  samples: ${snapshot.samples},
  epochs: ${snapshot.epochs},
};\n`;
}

export function exportValueModelPy(snapshot: ValueModelSnapshot): string {
  const weights = snapshot.weights.map(v => formatNumber(v, 8)).join(', ');
  const names = snapshot.featureNames.map(n => `'${n}'`).join(', ');
  return `# Auto-generated Connect6 value model
FEATURE_NAMES = [${names}]
WEIGHTS = [${weights}]
BIAS = ${formatNumber(snapshot.bias, 8)}

def sigmoid(x: float) -> float:
    if x >= 20:
        return 1.0
    if x <= -20:
        return 0.0
    return 1.0 / (1.0 + (2.718281828459045 ** (-x)))

def predict_prob(features):
    if len(features) != len(WEIGHTS):
        raise ValueError(f"Expected {len(WEIGHTS)} features, got {len(features)}")
    s = BIAS
    for w, f in zip(WEIGHTS, features):
        s += w * f
    return sigmoid(s)

def predict_value(features):
    return predict_prob(features) * 2.0 - 1.0
`;
}

export function exportValueModelCpp(snapshot: ValueModelSnapshot): string {
  const weights = snapshot.weights.map(v => formatNumber(v, 8)).join(', ');
  const names = snapshot.featureNames.map(n => `"${n}"`).join(', ');
  return `#pragma once

#include <cmath>
#include <stdexcept>
#include <vector>

static const int VALUE_FEATURES = ${snapshot.featureNames.length};
static const char* VALUE_FEATURE_NAMES[VALUE_FEATURES] = { ${names} };
static const double VALUE_MODEL_WEIGHTS[VALUE_FEATURES] = { ${weights} };
static const double VALUE_MODEL_BIAS = ${formatNumber(snapshot.bias, 8)};

inline double value_model_sigmoid(double x) {
  if (x >= 20.0) return 1.0;
  if (x <= -20.0) return 0.0;
  return 1.0 / (1.0 + std::exp(-x));
}

inline double value_model_predict_prob(const std::vector<double>& features) {
  if (features.size() != static_cast<size_t>(VALUE_FEATURES)) {
    throw std::invalid_argument("feature size mismatch");
  }
  double s = VALUE_MODEL_BIAS;
  for (int i = 0; i < VALUE_FEATURES; ++i) {
    s += VALUE_MODEL_WEIGHTS[i] * features[i];
  }
  return value_model_sigmoid(s);
}

inline double value_model_predict_value(const std::vector<double>& features) {
  return value_model_predict_prob(features) * 2.0 - 1.0;
}
`;
}

"""Train the NAFLD_Risk_Forecaster on the pre-split arrays.

The split is produced by `src.data_processing` (disjoint users, scalers fit on
train only). This module deliberately does NOT split anything itself -- doing so
here is what previously reintroduced leakage.
"""
import json
import os

import numpy as np
import tensorflow as tf

from .model_builder import build_multimodal_model

PROCESSED_DATA_PATH = 'data/processed/preprocessed_data.npz'
MODEL_SAVE_PATH = 'models/multimodal_model.h5'
HISTORY_PATH = 'reports/training_history.json'

EPOCHS = 200
BATCH_SIZE = 32
PATIENCE = 15


def main():
    print(f"Loading preprocessed data from {PROCESSED_DATA_PATH}...")
    if not os.path.exists(PROCESSED_DATA_PATH):
        raise SystemExit(
            "Preprocessed data not found. Run 'python -m src.data_processing' from the ml/ directory."
        )
    data = np.load(PROCESSED_DATA_PATH)

    X_lstm_train, X_mlp_train, y_train = data['X_lstm_train'], data['X_mlp_train'], data['y_train']
    X_lstm_val, X_mlp_val, y_val = data['X_lstm_val'], data['X_mlp_val'], data['y_val']

    print(f"  train: LSTM {X_lstm_train.shape}  MLP {X_mlp_train.shape}  y {y_train.shape}")
    print(f"  val  : LSTM {X_lstm_val.shape}  MLP {X_mlp_val.shape}  y {y_val.shape}")

    model = build_multimodal_model(
        lstm_input_shape=(X_lstm_train.shape[1], X_lstm_train.shape[2]),
        mlp_input_shape=(X_mlp_train.shape[1],),
    )
    model.summary()

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor='val_loss', patience=PATIENCE, restore_best_weights=True),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor='val_loss', factor=0.5, patience=max(3, PATIENCE // 3), min_lr=1e-5),
    ]

    print("\nStarting model training...")
    history = model.fit(
        [X_lstm_train, X_mlp_train], y_train,
        epochs=EPOCHS, batch_size=BATCH_SIZE,
        validation_data=([X_lstm_val, X_mlp_val], y_val),
        callbacks=callbacks, verbose=2,
    )

    os.makedirs(os.path.dirname(MODEL_SAVE_PATH), exist_ok=True)
    model.save(MODEL_SAVE_PATH)
    print(f"\nTrained model saved to {MODEL_SAVE_PATH}")

    # Persist the curves -- the previous version discarded `history`, which is
    # why no loss curve for this project has ever existed.
    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
    with open(HISTORY_PATH, 'w') as fh:
        json.dump({k: [float(v) for v in vals] for k, vals in history.history.items()},
                  fh, indent=2)
    print(f"Training history saved to {HISTORY_PATH}")
    print(f"Epochs run: {len(history.history['loss'])} (best val_loss "
          f"{min(history.history['val_loss']):.6f})")


if __name__ == '__main__':
    main()

import tensorflow as tf
from tensorflow.keras.models import Model
from tensorflow.keras.layers import Input, LSTM, Dense, Concatenate, Dropout

def build_multimodal_model(lstm_input_shape, mlp_input_shape):
    """
    Builds a multi-modal neural network with an LSTM and an MLP branch.

    Args:
        lstm_input_shape (tuple): Shape of the time-series input (sequence_length, num_features).
        mlp_input_shape (tuple): Shape of the tabular input (num_features,).

    Returns:
        keras.Model: The compiled multi-modal model.
    """
    print("Building the multi-modal model architecture...")

    # --- 1. Time-Series Branch (LSTM) for Watch Data ---
    # This branch is the "Behavioral Analyst"
    lstm_input = Input(shape=lstm_input_shape, name='lstm_input')
    # LSTM layer to capture temporal patterns. `return_sequences=False` means we only get the final output.
    lstm_layer = LSTM(64, return_sequences=False)(lstm_input)
    lstm_dropout = Dropout(0.2)(lstm_layer) # Dropout for regularization

    # --- 2. Tabular Branch (MLP) for Diet & Static Data ---
    # This branch is the "Nutritionist & Profiler"
    mlp_input = Input(shape=mlp_input_shape, name='mlp_input')
    dense_layer_1 = Dense(32, activation='relu')(mlp_input)
    dense_layer_2 = Dense(16, activation='relu')(dense_layer_1)
    mlp_dropout = Dropout(0.2)(dense_layer_2)

    # --- 3. Fusion Layer ---
    # This is where the two experts' reports are combined
    fusion_layer = Concatenate()([lstm_dropout, mlp_dropout])
    
    # --- 4. Prediction Head ---
    # A final set of layers to make a decision based on the combined information
    head_dense_1 = Dense(32, activation='relu')(fusion_layer)
    head_dropout = Dropout(0.3)(head_dense_1)
    
    # The final output layer has 2 neurons (for TG and GGT)
    # 'linear' activation is used for regression problems (predicting a continuous value)
    output_layer = Dense(2, activation='linear', name='output')(head_dropout)

    # --- 5. Create and Compile the Model ---
    model = Model(inputs=[lstm_input, mlp_input], outputs=output_layer, name='NAFLD_Risk_Forecaster')
    
    # Compile the model with an optimizer, loss function, and metrics
    # Adam is a great default optimizer. Mean Squared Error is standard for regression.
    model.compile(optimizer='adam', 
                  loss='mean_squared_error', 
                  metrics=['mean_absolute_error'])
    
    print("Model built and compiled successfully.")
    
    return model

if __name__ == '__main__':
    # This is for testing the builder function directly if needed
    
    # Define dummy input shapes for testing
    # (14 days, 6 watch features)
    dummy_lstm_shape = (14, 6) 
    # (8 tabular features)
    dummy_mlp_shape = (8,)     

    # Build the model
    test_model = build_multimodal_model(dummy_lstm_shape, dummy_mlp_shape)
    
    # Print a summary of the model's architecture
    test_model.summary()
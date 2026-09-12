import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, ArrowLeft, User, Ruler, Scale, Users, Cigarette, Wine, Shield, CheckCircle, Watch, Smartphone } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import toast from 'react-hot-toast';

const OnboardingPage = () => {
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState({
    name: '',
    age: '',
    biologicalSex: '',
    height: '',
    weight: '',
    familyHistory: '',
    smokingStatus: '',
    alcoholStatus: '',
  });
  const [showPermissions, setShowPermissions] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const { signup } = useAuth();
  const navigate = useNavigate();

  const steps = [
    {
      id: 'name',
      title: "What's your name?",
      subtitle: "We'll use this to personalize your experience",
      icon: User,
      field: 'name',
      type: 'text',
      placeholder: 'Enter your full name',
      explanation: "Your name helps us create a more personal and engaging experience. We'll use it to greet you and customize your wellness journey."
    },
    {
      id: 'age',
      title: "How old are you?",
      subtitle: "Age helps us understand your metabolic profile",
      icon: User,
      field: 'age',
      type: 'number',
      placeholder: 'Enter your age',
      explanation: "Age is a key factor in metabolic health. Different age groups have different risk factors and recommendations for the conditions we monitor."
    },
    {
      id: 'biologicalSex',
      title: "What's your biological sex?",
      subtitle: "This affects your metabolic risk factors",
      icon: User,
      field: 'biologicalSex',
      type: 'select',
      options: ['Male', 'Female', 'Other'],
      explanation: "Biological sex influences how your body processes nutrients and responds to different health interventions. This helps us provide more accurate recommendations."
    },
    {
      id: 'height',
      title: "What's your height?",
      subtitle: "Height helps calculate your BMI and metabolic rate",
      icon: Ruler,
      field: 'height',
      type: 'number',
      placeholder: 'Height in cm',
      explanation: "Height is essential for calculating your Body Mass Index (BMI) and understanding your body composition. This helps us assess your metabolic health more accurately."
    },
    {
      id: 'weight',
      title: "What's your current weight?",
      subtitle: "Weight helps track your metabolic progress",
      icon: Scale,
      field: 'weight',
      type: 'number',
      placeholder: 'Weight in kg',
      explanation: "Weight tracking helps us monitor changes in your body composition and metabolic health over time. Combined with height, it gives us your BMI."
    },
    {
      id: 'familyHistory',
      title: "Any family history?",
      subtitle: "Family history helps assess your risk factors",
      icon: Users,
      field: 'familyHistory',
      type: 'select',
      options: ['Fatty Liver', 'Type-2 Diabetes', 'Hypertension', 'None'],
      explanation: "Family history is one of the strongest predictors of metabolic disease risk. Knowing this helps us create a more targeted prevention strategy."
    },
    {
      id: 'smokingStatus',
      title: "Do you smoke?",
      subtitle: "Smoking affects your metabolic health",
      icon: Cigarette,
      field: 'smokingStatus',
      type: 'select',
      options: ['Never smoked', 'Former smoker', 'Current smoker'],
      explanation: "Smoking significantly impacts your metabolic health and increases risk for the conditions we monitor. This helps us provide appropriate guidance."
    },
    {
      id: 'alcoholStatus',
      title: "How often do you drink alcohol?",
      subtitle: "Alcohol consumption affects liver health",
      icon: Wine,
      field: 'alcoholStatus',
      type: 'select',
      options: ['Never', 'Occasionally', 'Moderately', 'Regularly'],
      explanation: "Alcohol consumption directly impacts liver health and can contribute to fatty liver disease. Understanding your pattern helps us provide better guidance."
    }
  ];

  const handleInputChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      setShowPermissions(true);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && canProceed) {
      e.preventDefault();
      handleNext();
    }
  };



  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleComplete = async () => {
    try {
      await signup(formData);
      navigate('/dashboard');
    } catch (error) {
      toast.error('Something went wrong. Please try again.');
    }
  };

  const handleConnectWearable = async () => {
    setIsConnecting(true);
    try {
      // Google Fit was removed: new developer registrations closed on
      // 1 May 2024 and the APIs are being decommissioned. Wearable data now
      // arrives through POST /api/wearable/import (any provider export) or
      // POST /api/wearable/demo. See backend2/src/services/wearableImportService.js.
      const result = { success: false, reason: 'wearable-import' };
        
        await signup(formData);
        navigate('/dashboard');
      } else {
        toast.error(result.error || 'Failed to connect to Google Fit');
      }
    } catch (error) {
      console.error('Google Fit connection error:', error);
      toast.error('Failed to connect to Google Fit. Please try again.');
    } finally {
      setIsConnecting(false);
    }
  };

  const currentStepData = steps[currentStep];
  const StepIcon = currentStepData.icon;
  const canProceed = formData[currentStepData.field];

  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      if (e.key === 'Enter' && canProceed && !showPermissions) {
        e.preventDefault();
        handleNext();
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [canProceed, showPermissions, handleNext]);

  if (showPermissions) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="glassmorphism-card p-8 max-w-md w-full text-center"
        >
          <div className="flex items-center justify-center space-x-2 mb-6">
            <Watch className="w-12 h-12 text-primary-600" />
            <Smartphone className="w-12 h-12 text-secondary-600" />
          </div>
          <h2 className="text-2xl font-semibold text-slate-800 mb-4">
            Connect Your Wearable Device
          </h2>
          <p className="text-slate-600 mb-6">
            Sync your smartwatch or fitness tracker with Google Fit to automatically track your health metrics and get personalized insights.
          </p>
          
          <div className="space-y-4 mb-8">
            <div className="flex items-center space-x-3 text-left">
              <CheckCircle className="w-5 h-5 text-secondary-600 flex-shrink-0" />
              <span className="text-sm text-slate-600">Automatically track daily steps and activity</span>
            </div>
            <div className="flex items-center space-x-3 text-left">
              <CheckCircle className="w-5 h-5 text-secondary-600 flex-shrink-0" />
              <span className="text-sm text-slate-600">Monitor heart rate and sleep patterns</span>
            </div>
            <div className="flex items-center space-x-3 text-left">
              <CheckCircle className="w-5 h-5 text-secondary-600 flex-shrink-0" />
              <span className="text-sm text-slate-600">Sync with Google Fit and health apps</span>
            </div>
            <div className="flex items-center space-x-3 text-left">
              <CheckCircle className="w-5 h-5 text-secondary-600 flex-shrink-0" />
              <span className="text-sm text-slate-600">Get personalized health insights</span>
            </div>
          </div>

          <div className="space-y-3">
            <button
              onClick={handleConnectWearable}
              disabled={isConnecting}
              className="btn-primary w-full flex items-center justify-center space-x-2"
            >
              {isConnecting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <Watch className="w-5 h-5" />
                  <span>Connect with Google Fit</span>
                </>
              )}
            </button>
            <button
              onClick={handleComplete}
              className="btn-secondary w-full"
            >
              Skip for Now
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        {/* Progress Bar */}
        <div className="mb-8">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm text-slate-600">Step {currentStep + 1} of {steps.length}</span>
            <span className="text-sm text-slate-600">{Math.round(((currentStep + 1) / steps.length) * 100)}%</span>
          </div>
          <div className="w-full bg-slate-200 rounded-full h-2">
            <motion.div
              className="bg-primary-600 h-2 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        </div>

        {/* Step Content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3 }}
            className="glassmorphism-card p-8"
          >
            {/* Step Header */}
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-primary-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <StepIcon className="w-8 h-8 text-primary-700" />
              </div>
              <h2 className="text-2xl font-semibold text-slate-800 mb-2">
                {currentStepData.title}
              </h2>
              <p className="text-slate-600">
                {currentStepData.subtitle}
              </p>
            </div>

            {/* Why This Matters */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-6">
              <h3 className="font-medium text-slate-800 mb-2">Why this matters:</h3>
              <p className="text-sm text-slate-700">
                {currentStepData.explanation}
              </p>
            </div>

            {/* Input Field */}
            <div className="mb-8">
              {currentStepData.type === 'text' || currentStepData.type === 'number' ? (
                <input
                  type={currentStepData.type}
                  value={formData[currentStepData.field]}
                  onChange={(e) => handleInputChange(currentStepData.field, e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={currentStepData.placeholder}
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-600 focus:border-transparent transition-all duration-200 bg-white"
                  autoFocus
                />
              ) : currentStepData.type === 'select' ? (
                <select
                  value={formData[currentStepData.field]}
                  onChange={(e) => handleInputChange(currentStepData.field, e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-600 focus:border-transparent transition-all duration-200 bg-white"
                  autoFocus
                >
                  <option value="">Select an option</option>
                  {currentStepData.options.map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              ) : null}
            </div>

            {/* Navigation Buttons */}
            <div className="flex justify-between">
              <button
                onClick={handleBack}
                disabled={currentStep === 0}
                className="btn-secondary flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ArrowLeft className="w-5 h-5" />
                <span>Back</span>
              </button>
              
              <button
                onClick={handleNext}
                disabled={!canProceed}
                className="btn-primary flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>{currentStep === steps.length - 1 ? 'Complete' : 'Next'}</span>
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};

export default OnboardingPage;

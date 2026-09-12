import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, Activity, Moon, Target, Award, Zap, Plus, Utensils, Heart, Droplet } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useNavigate } from 'react-router-dom';

const DashboardPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const getFattyLiverIndexColor = (score) => {
    if (score >= 80) return 'text-wellness-score-excellent';
    if (score >= 60) return 'text-wellness-score-good';
    if (score >= 40) return 'text-wellness-score-warning';
    return 'text-wellness-score-critical';
  };

  const getFattyLiverIndexBg = (score) => {
    if (score >= 80) return 'from-wellness-score-excellent to-green-400';
    if (score >= 60) return 'from-wellness-score-good to-yellow-400';
    if (score >= 40) return 'from-wellness-score-warning to-orange-400';
    return 'from-wellness-score-critical to-red-400';
  };

  const getGreeting = () => {
    const hour = currentTime.getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const dailyMetrics = [
    {
      label: 'Calories',
      value: 1850,
      target: 2000,
      icon: Target,
      color: 'from-orange-400 to-red-400'
    },
    {
      label: 'Steps',
      value: 8420,
      target: 10000,
      icon: Activity,
      color: 'from-blue-400 to-purple-400'
    },
    {
      label: 'Sleep',
      value: 7.5,
      target: 8,
      icon: Moon,
      color: 'from-indigo-400 to-blue-400'
    },
    {
      label: 'Water',
      value: 6,
      target: 8,
      icon: Droplet,
      color: 'from-cyan-400 to-blue-400'
    }
  ];

  const todaysFocus = {
    title: "Focus on Post-Meal Movement",
    description: "Take a 10-minute walk after your main meals today. This simple habit can improve your blood sugar control by up to 30%.",
    icon: TrendingUp,
    color: 'from-green-400 to-teal-400'
  };

  const recentAchievements = [
    { title: '7-Day Streak', description: 'Logged meals for 7 consecutive days', points: 50 },
    { title: 'Step Goal Met', description: 'Achieved daily step goal 5 times this week', points: 75 },
    { title: 'Healthy Choice', description: 'Made 3 healthy food swaps this week', points: 25 }
  ];

  return (
    <div className="relative min-h-screen bg-slate-50 pb-32 md:pb-10">
      <div className="relative z-10">
        <div className="responsive-container">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6"
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-gradient">
              {getGreeting()}, {user?.name || 'User'}!
            </h1>
            <p className="text-gray-600">
              {currentTime.toLocaleDateString('en-US', { 
                weekday: 'long', 
                month: 'long', 
                day: 'numeric' 
              })}
            </p>
          </div>
          <div className="w-12 h-12 md:w-14 md:h-14 bg-gradient-to-r from-primary-500 to-teal-500 rounded-full flex items-center justify-center text-white font-semibold shadow-soft">
            {user?.name?.charAt(0) || 'U'}
          </div>
        </div>
      </motion.div>

      {/* Today's Focus Card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="glassmorphism-login p-6 mb-6 shadow-glow card-hover border-l-4 border-teal-400 will-change-transform backface-visibility-hidden"
        whileHover={{ scale: 1.02 }}
      >
        <div className="flex items-start space-x-4">
          <div className={`w-14 h-14 bg-gradient-to-r ${todaysFocus.color} rounded-2xl flex items-center justify-center text-white shadow-lg transform -rotate-3`}>
            <todaysFocus.icon className="w-7 h-7" />
          </div>
          <div className="flex-1">
            <h3 className="text-xl font-semibold text-gradient bg-gradient-to-r from-teal-600 to-green-500 mb-3">
              Today's Focus
            </h3>
            <h4 className="text-lg font-medium text-gray-800 mb-2">
              {todaysFocus.title}
            </h4>
            <p className="text-gray-700 leading-relaxed">
              {todaysFocus.description}
            </p>
          </div>
        </div>
      </motion.div>

      {/* Google Fit Widget */}

      {/* Quick Actions */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="glassmorphism-login p-6 mb-6 shadow-glow relative overflow-hidden"
      >
        <div className="absolute -top-10 -right-10 w-32 h-32 bg-green-100 rounded-full mix-blend-multiply filter blur-xl opacity-60"></div>
        
        <h3 className="text-xl font-semibold text-gradient bg-gradient-to-r from-green-600 to-teal-500 mb-5 relative z-10">
          Quick Actions
        </h3>
        
        <div className="grid grid-cols-1 gap-4 relative z-10">
          <motion.button
            onClick={() => navigate('/logging')}
            className="flex items-center justify-between p-4 bg-gradient-to-r from-green-500 to-teal-500 hover:from-green-600 hover:to-teal-600 rounded-xl text-white shadow-lg transition-all duration-300"
            whileHover={{ scale: 1.02, y: -2 }}
            whileTap={{ scale: 0.98 }}
          >
            <div className="flex items-center space-x-4">
              <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
                <Plus className="w-6 h-6" />
              </div>
              <div className="text-left">
                <div className="font-semibold text-lg">Quick Log</div>
                <div className="text-green-100 text-sm">Log meals, vitals & activities</div>
              </div>
            </div>
            <div className="flex space-x-2">
              <Utensils className="w-5 h-5 text-green-200" />
              <Heart className="w-5 h-5 text-green-200" />
              <Activity className="w-5 h-5 text-green-200" />
            </div>
          </motion.button>
        </div>
      </motion.div>

      {/* Combined Fatty Liver Index and Daily Progress */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="glassmorphism-login p-6 mb-6 shadow-glow relative overflow-hidden will-change-transform backface-visibility-hidden"
        whileHover={{ scale: 1.01 }}
      >
        <div className="absolute -top-20 -right-20 w-40 h-40 bg-primary-100 rounded-full mix-blend-multiply filter blur-xl opacity-70"></div>
        <div className="absolute -bottom-20 -left-20 w-40 h-40 bg-teal-100 rounded-full mix-blend-multiply filter blur-xl opacity-70"></div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 relative z-10">
          {/* Fatty Liver Index - Left Half */}
          <div className="text-center">
            <h2 className="text-xl font-semibold text-gradient bg-gradient-to-r from-primary-600 to-teal-500 mb-6">
              Your Fatty Liver Index
            </h2>
            
            <div className="relative inline-block mb-6">
              <svg className="w-44 h-44 transform -rotate-90" viewBox="0 0 36 36">
                {/* Background circle */}
                <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#e5e7eb" strokeWidth="1.5" opacity="0.3" />
                
                {/* Dotted circle */}
                <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#e5e7eb" strokeWidth="0.3" strokeDasharray="0.5,0.5" />
                
                {/* Score path */}
                <path
                  d="M18 2.0845
                    a 15.9155 15.9155 0 0 1 0 31.831
                    a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="url(#gradient)"
                  strokeWidth="3"
                  strokeDasharray={`${(user?.fattyLiverIndex || 75) * 1.4}, 100`}
                  strokeLinecap="round"
                  className="drop-shadow-lg"
                />
                
                <defs>
                  <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor={getFattyLiverIndexColor(user?.fattyLiverIndex || 75).replace('text-', '')} />
                    <stop offset="100%" stopColor={getFattyLiverIndexBg(user?.fattyLiverIndex || 75).split(' ')[1]} />
                  </linearGradient>
                </defs>
              </svg>
              
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center bg-white/30 backdrop-blur-sm w-24 h-24 rounded-full flex flex-col items-center justify-center shadow-inner">
                  <div className={`text-5xl font-extrabold ${getFattyLiverIndexColor(user?.fattyLiverIndex || 75)}`}>
                    {user?.fattyLiverIndex || 75}
                  </div>
                  <div className="text-xs text-gray-600 font-medium">/ 100</div>
                </div>
              </div>
            </div>
            
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="bg-white/50 backdrop-blur-sm py-3 px-4 rounded-xl shadow-inner"
            >
              <p className="text-gray-700 font-medium">
                {user?.fattyLiverIndex >= 80 ? 'Excellent! Keep up the great work!' :
                 user?.fattyLiverIndex >= 60 ? 'Good progress! You\'re on the right track.' :
                 user?.fattyLiverIndex >= 40 ? 'Room for improvement. Let\'s work on this together.' :
                 'Let\'s focus on building healthy habits together.'}
              </p>
            </motion.div>
          </div>
          
          {/* Daily Progress - Right Half */}
          <div>
            <h3 className="text-xl font-semibold text-gradient bg-gradient-to-r from-blue-600 to-purple-500 mb-5">
              Today's Progress
            </h3>
            
            <div className="grid grid-cols-2 gap-4">
              {dailyMetrics.map((metric, index) => {
                const Icon = metric.icon;
                const percentage = Math.min((metric.value / metric.target) * 100, 100);
                
                return (
                  <motion.div 
                    key={metric.label} 
                    className="text-center bg-white/40 backdrop-blur-sm p-3 rounded-xl shadow-inner will-change-transform backface-visibility-hidden"
                    whileHover={{ scale: 1.05, backgroundColor: 'rgba(255, 255, 255, 0.5)' }}
                    transition={{ type: 'spring', stiffness: 300 }}
                  >
                    <div className="relative inline-block mb-2">
                      <svg className="w-16 h-16 transform -rotate-90" viewBox="0 0 36 36">
                        {/* Background circle */}
                        <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#e5e7eb" strokeWidth="1.2" opacity="0.3" />
                        
                        {/* Dotted circle */}
                        <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#e5e7eb" strokeWidth="0.2" strokeDasharray="0.3,0.3" />
                        
                        {/* Progress path */}
                        <path
                          d="M18 2.0845
                            a 15.9155 15.9155 0 0 1 0 31.831
                            a 15.9155 15.9155 0 0 1 0 -31.831"
                          fill="none"
                          stroke={`url(#gradient-${index})`}
                          strokeWidth="2.5"
                          strokeDasharray={`${percentage * 1.4}, 100`}
                          strokeLinecap="round"
                          className="drop-shadow-md"
                        />
                        <defs>
                          <linearGradient id={`gradient-${index}`} x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor={metric.color.split(' ')[0].replace('from-', '')} />
                            <stop offset="100%" stopColor={metric.color.split(' ')[1].replace('to-', '')} />
                          </linearGradient>
                        </defs>
                      </svg>
                      
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="bg-white/60 backdrop-blur-sm w-10 h-10 rounded-full flex items-center justify-center shadow-inner">
                          <Icon className="w-5 h-5" style={{ color: metric.color.split(' ')[0].replace('from-', '') }} />
                        </div>
                      </div>
                    </div>
                    
                    <div className="text-sm font-semibold text-gray-800 mb-1">{metric.label}</div>
                    <div className="flex items-center justify-center space-x-1">
                      <span className="text-sm font-bold" style={{ color: metric.color.split(' ')[0].replace('from-', '') }}>
                        {metric.value}
                      </span>
                      <span className="text-xs text-gray-500 font-medium">
                        / {metric.target}
                      </span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Recent Achievements */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="glassmorphism-login p-6 mb-6 shadow-glow relative overflow-hidden"
        whileHover={{ scale: 1.01 }}
      >
        <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-accent-100 rounded-full mix-blend-multiply filter blur-xl opacity-60"></div>
        
        <div className="flex items-center justify-between mb-5 relative z-10">
          <h3 className="text-xl font-semibold text-gradient bg-gradient-to-r from-accent-600 to-yellow-500">
            Recent Achievements
          </h3>
          <div className="w-10 h-10 bg-gradient-to-r from-accent-500 to-yellow-400 rounded-full flex items-center justify-center shadow-md">
            <Award className="w-5 h-5 text-white" />
          </div>
        </div>
        
        <div className="space-y-4 relative z-10">
          {recentAchievements.map((achievement, index) => (
            <motion.div
              key={achievement.title}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.5 + index * 0.1 }}
              className="flex items-center justify-between p-4 bg-white/50 backdrop-blur-md rounded-xl shadow-md hover:shadow-lg transition-all duration-300 border-l-2 border-accent-400"
              whileHover={{ scale: 1.02, backgroundColor: 'rgba(255, 255, 255, 0.6)' }}
            >
              <div>
                <div className="font-semibold text-gray-800 text-lg">{achievement.title}</div>
                <div className="text-gray-600">{achievement.description}</div>
              </div>
              <div className="flex items-center space-x-2 bg-accent-50 py-1 px-3 rounded-full shadow-inner">
                <Zap className="w-5 h-5 text-accent-500" />
                <span className="text-base font-bold text-accent-600">+{achievement.points}</span>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {/* Quick Stats */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="glassmorphism-login p-6 shadow-glow relative overflow-hidden mb-6"
        whileHover={{ scale: 1.01 }}
      >
        <div className="absolute -top-10 -left-10 w-32 h-32 bg-primary-100 rounded-full mix-blend-multiply filter blur-xl opacity-60"></div>
        
        <div className="flex items-center justify-between mb-5 relative z-10">
          <h3 className="text-xl font-semibold text-gradient bg-gradient-to-r from-primary-600 to-blue-500">
            Quick Stats
          </h3>
          <div className="w-10 h-10 bg-gradient-to-r from-primary-500 to-blue-400 rounded-full flex items-center justify-center shadow-md">
            <Activity className="w-5 h-5 text-white" />
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-6 relative z-10">
          <motion.div 
            className="flex flex-col items-center justify-center p-5 bg-white/50 backdrop-blur-md rounded-xl shadow-md border-t-2 border-primary-400"
            whileHover={{ scale: 1.05, backgroundColor: 'rgba(255, 255, 255, 0.6)' }}
          >
            <div className="text-4xl font-bold text-gradient bg-gradient-to-r from-primary-600 to-blue-500">{user?.streak || 0}</div>
            <div className="text-gray-700 font-medium mt-1">Day Streak</div>
          </motion.div>
          
          <motion.div 
            className="flex flex-col items-center justify-center p-5 bg-white/50 backdrop-blur-md rounded-xl shadow-md border-t-2 border-accent-400"
            whileHover={{ scale: 1.05, backgroundColor: 'rgba(255, 255, 255, 0.6)' }}
          >
            <div className="text-4xl font-bold text-gradient bg-gradient-to-r from-accent-600 to-yellow-500">{user?.level || 'Novice'}</div>
            <div className="text-gray-700 font-medium mt-1">Current Level</div>
          </motion.div>
        </div>
      </motion.div>
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { FileText, Download, Share2, Printer, Calendar } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { generateDoctorsReport } from '../../services/profileService.jsx';

const HealthReports = () => {
  const { user } = useAuth();
  const [report, setReport] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerateReport = () => {
    setIsGenerating(true);
    
    // Simulate API delay
    setTimeout(() => {
      if (user?.id) {
        // Throws until the report is built from real user data. See profileService.
        const reportData = generateDoctorsReport(user.id);
        setReport(reportData);
      }
      setIsGenerating(false);
    }, 1500);
  };

  const handleDownload = () => {
    // In a real app, this would generate a PDF or other document format
    alert('In a production app, this would download a PDF report');
  };

  const handleShare = () => {
    // In a real app, this would open sharing options
    alert('In a production app, this would open sharing options');
  };

  const handlePrint = () => {
    // In a real app, this would open the print dialog
    alert('In a production app, this would open the print dialog');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="glassmorphism-card p-6"
    >
      <div className="flex items-center space-x-3 mb-6">
        <FileText className="w-6 h-6 text-primary-500" />
        <h3 className="text-lg font-semibold text-gray-800">Health Reports</h3>
      </div>
      
      {!report ? (
        <div className="text-center py-8 bg-white/30 rounded-lg">
          <FileText className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-500 mb-4">Generate a comprehensive health report for your doctor</p>
          <button 
            onClick={handleGenerateReport}
            disabled={isGenerating}
            className="btn-primary flex items-center space-x-2 mx-auto"
          >
            {isGenerating ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>Generating...</span>
              </>
            ) : (
              <>
                <FileText className="w-5 h-5" />
                <span>Generate Doctor's Report</span>
              </>
            )}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-2">
              <Calendar className="w-5 h-5 text-gray-500" />
              <span className="text-sm text-gray-600">
                Generated on {new Date(report.generatedAt).toLocaleDateString()}
              </span>
            </div>
            <div className="flex space-x-2">
              <button 
                onClick={handleDownload}
                className="p-2 text-gray-600 hover:text-primary-600 hover:bg-primary-50 rounded-full transition-colors"
                title="Download Report"
              >
                <Download className="w-5 h-5" />
              </button>
              <button 
                onClick={handleShare}
                className="p-2 text-gray-600 hover:text-primary-600 hover:bg-primary-50 rounded-full transition-colors"
                title="Share Report"
              >
                <Share2 className="w-5 h-5" />
              </button>
              <button 
                onClick={handlePrint}
                className="p-2 text-gray-600 hover:text-primary-600 hover:bg-primary-50 rounded-full transition-colors"
                title="Print Report"
              >
                <Printer className="w-5 h-5" />
              </button>
            </div>
          </div>
          
          <div className="bg-white/50 rounded-lg p-4 space-y-4">
            <h4 className="font-medium text-gray-800">Recent Vitals</h4>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Blood Pressure</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Heart Rate</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Blood Glucose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white/30">
                  {report.data.recentVitals.map((vital, index) => (
                    <tr key={index}>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{vital.date}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{vital.bloodPressure}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{vital.heartRate} bpm</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{vital.bloodGlucose} mg/dL</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white/50 rounded-lg p-4">
              <h4 className="font-medium text-gray-800 mb-3">Medications</h4>
              <ul className="space-y-2">
                {report.data.medications.map((med, index) => (
                  <li key={index} className="text-sm text-gray-700 flex justify-between">
                    <span>{med.name} ({med.dosage})</span>
                    <span className="text-gray-500">{med.frequency}</span>
                  </li>
                ))}
              </ul>
            </div>
            
            <div className="bg-white/50 rounded-lg p-4">
              <h4 className="font-medium text-gray-800 mb-3">Conditions & Allergies</h4>
              <div className="mb-3">
                <h5 className="text-sm font-medium text-gray-600 mb-1">Conditions</h5>
                <div className="flex flex-wrap gap-2">
                  {report.data.conditions.map((condition, index) => (
                    <span key={index} className="px-2 py-1 bg-primary-100 text-primary-800 rounded text-xs">
                      {condition}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <h5 className="text-sm font-medium text-gray-600 mb-1">Allergies</h5>
                <div className="flex flex-wrap gap-2">
                  {report.data.allergies.map((allergy, index) => (
                    <span key={index} className="px-2 py-1 bg-red-100 text-red-800 rounded text-xs">
                      {allergy}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          
          <div className="flex justify-center">
            <button 
              onClick={handleGenerateReport}
              className="btn-secondary flex items-center space-x-2"
            >
              <FileText className="w-5 h-5" />
              <span>Regenerate Report</span>
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
};

export default HealthReports;